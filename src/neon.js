// Neon PostgreSQL cloud sync: batched, queued, fire-and-forget.
// API requests never await Neon — they enqueue deltas, a single worker
// flushes merged batches every FLUSH_MS. Max queue age bounded; a stuck
// Neon never throttles DeepSeek calls.

let pool = null;
let lastError = null;
let totalFlushed = 0;

const FLUSH_MS = 250;
const MAX_QUEUE_KEYS = 50000;
const MAX_TOKEN_OPS = 10000;
const MAX_FAILURES = 3;

const usagePending = new Map(); // key: date|model|scope_hash -> delta
const tokenOps = []; // {type:'upsert'|'delete', row}
let failureCount = 0;
let workerBusy = false;

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  alias TEXT,
  token TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  signature TEXT PRIMARY KEY,
  token_id INTEGER,
  deepseek_session_id TEXT,
  parent_message_id INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS token_usage (
  date TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  scope_hash TEXT NOT NULL DEFAULT '',
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model, scope_hash)
);`;

function getUrl() {
  return (process.env.NEON_DATABASE_URL || '').trim();
}

async function initNeon() {
  const url = getUrl();
  if (!url) return false;
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10000 });
    await pool.query('SELECT 1');
    await pool.query(TABLES_SQL);
    lastError = null;
    console.log('Neon sync connected');
    startWorker();
    return true;
  } catch (e) {
    lastError = e.message;
    console.error('Neon init failed (sync disabled, will retry on demand):', e.message);
    try { await pool?.end(); } catch (_) {}
    pool = null;
    return false;
  }
}

function startWorker() {
  if (global.__neonFlushTimer) return;
  global.__neonFlushTimer = setInterval(flush, FLUSH_MS);
  global.__neonFlushTimer.unref?.();
}

function enqueueUsageDelta(delta) {
  if (!delta) return;
  const key = `${delta.date}|${delta.model}|${delta.scope_hash}`;
  const cur = usagePending.get(key) || { date: delta.date, model: delta.model, scope_hash: delta.scope_hash, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0, cost: 0, requests: 0 };
  cur.prompt_tokens += delta.prompt_tokens || 0;
  cur.cached_tokens += delta.cached_tokens || 0;
  cur.completion_tokens += delta.completion_tokens || 0;
  cur.reasoning_tokens += delta.reasoning_tokens || 0;
  cur.total_tokens += delta.total_tokens || 0;
  cur.cost += delta.cost || 0;
  cur.requests += delta.requests || 0;
  usagePending.set(key, cur);
  if (usagePending.size > MAX_QUEUE_KEYS) {
    console.warn('Neon usage queue over cap, forcing early flush');
    flush();
  }
}

function enqueueTokenOp(type, row) {
  tokenOps.push({ type, row });
  if (tokenOps.length > MAX_TOKEN_OPS) {
    const dropped = tokenOps.splice(0, tokenOps.length - MAX_TOKEN_OPS);
    console.warn(`Neon token queue over cap, dropped ${dropped.length} oldest ops`);
  }
}

async function flush() {
  if (workerBusy || !pool) return;
  if (!usagePending.size && !tokenOps.length) return;
  workerBusy = true;
  const usageBatch = [...usagePending.values()];
  const tokenBatch = tokenOps.splice(0, tokenOps.length);
  usagePending.clear();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of usageBatch) {
        await client.query(
          `INSERT INTO token_usage (date, model, scope_hash, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, total_tokens, cost, requests)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(date, model, scope_hash) DO UPDATE SET
             prompt_tokens = token_usage.prompt_tokens + EXCLUDED.prompt_tokens,
             cached_tokens = token_usage.cached_tokens + EXCLUDED.cached_tokens,
             completion_tokens = token_usage.completion_tokens + EXCLUDED.completion_tokens,
             reasoning_tokens = token_usage.reasoning_tokens + EXCLUDED.reasoning_tokens,
             total_tokens = token_usage.total_tokens + EXCLUDED.total_tokens,
             cost = token_usage.cost + EXCLUDED.cost,
             requests = token_usage.requests + EXCLUDED.requests`,
          [u.date, u.model, u.scope_hash, u.prompt_tokens, u.cached_tokens, u.completion_tokens, u.reasoning_tokens, u.total_tokens, u.cost, u.requests]
        );
      }
      for (const t of tokenBatch) {
        if (t.type === 'upsert') {
          await client.query(
            'INSERT INTO tokens (id, alias, token, status) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET alias=EXCLUDED.alias, token=EXCLUDED.token, status=EXCLUDED.status',
            [t.row.id, t.row.alias ?? null, t.row.token, t.row.status]
          );
        } else {
          await client.query('DELETE FROM tokens WHERE id=$1', [t.row.id]);
        }
      }
      await client.query('COMMIT');
      totalFlushed += usageBatch.length + tokenBatch.length;
      failureCount = 0;
      lastError = null;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    failureCount += 1;
    lastError = e.message;
    console.error(`Neon flush failed (${failureCount}/${MAX_FAILURES}): ${e.message}`);
    if (failureCount < MAX_FAILURES) {
      // put items back at the front
      for (const u of usageBatch) usagePending.set(`${u.date}|${u.model}|${u.scope_hash}`, mergeBack(usagePending.get(`${u.date}|${u.model}|${u.scope_hash}`), u));
      tokenOps.unshift(...tokenBatch);
    } else {
      console.error(`Neon sync dropping batch of ${usageBatch.length} usage rows + ${tokenBatch.length} token ops after repeated failure`);
      failureCount = 0;
    }
  } finally {
    workerBusy = false;
  }
}

function mergeBack(existing, u) {
  if (!existing) return u;
  existing.prompt_tokens += u.prompt_tokens;
  existing.cached_tokens += u.cached_tokens;
  existing.completion_tokens += u.completion_tokens;
  existing.reasoning_tokens += u.reasoning_tokens;
  existing.total_tokens += u.total_tokens;
  existing.cost += u.cost;
  existing.requests += u.requests;
  return existing;
}

async function uploadAll() {
  if (!pool) {
    const ok = await initNeon();
    if (!ok) return { ok: false, error: lastError || 'Neon not configured' };
  }
  const { getDb } = require('./db');
  try {
    const t = getDb().prepare('SELECT id, alias, token, status FROM tokens').all();
    const s = getDb().prepare('SELECT signature, token_id, deepseek_session_id, parent_message_id FROM sessions').all();
    const u = getDb().prepare('SELECT date, model, scope_hash, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, total_tokens, cost, requests FROM token_usage').all();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of t) {
        await client.query('INSERT INTO tokens (id, alias, token, status) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET alias=EXCLUDED.alias, token=EXCLUDED.token, status=EXCLUDED.status', [row.id, row.alias, row.token, row.status]);
      }
      for (const row of s) {
        await client.query('INSERT INTO sessions (signature, token_id, deepseek_session_id, parent_message_id) VALUES ($1,$2,$3,$4) ON CONFLICT(signature) DO UPDATE SET token_id=EXCLUDED.token_id, deepseek_session_id=EXCLUDED.deepseek_session_id, parent_message_id=EXCLUDED.parent_message_id', [row.signature, row.token_id, row.deepseek_session_id, row.parent_message_id]);
      }
      for (const row of u) {
        await client.query(
          `INSERT INTO token_usage (date, model, scope_hash, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, total_tokens, cost, requests)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(date, model, scope_hash) DO UPDATE SET
             prompt_tokens=EXCLUDED.prompt_tokens, cached_tokens=EXCLUDED.cached_tokens, completion_tokens=EXCLUDED.completion_tokens,
             reasoning_tokens=EXCLUDED.reasoning_tokens, total_tokens=EXCLUDED.total_tokens, cost=EXCLUDED.cost, requests=EXCLUDED.requests`,
          [row.date, row.model, row.scope_hash, row.prompt_tokens, row.cached_tokens, row.completion_tokens, row.reasoning_tokens, row.total_tokens, row.cost, row.requests]
        );
      }
      await client.query('COMMIT');
      return { ok: true, tokens: t.length, sessions: s.length, token_usage: u.length };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    lastError = e.message;
    return { ok: false, error: e.message };
  }
}

async function getStatus() {
  const connected = Boolean(pool);
  let counts = null;
  if (connected) {
    try {
      const r = await pool.query(`SELECT
        (SELECT COUNT(*) FROM tokens) AS tokens,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM token_usage) AS token_usage`);
      counts = r.rows[0];
    } catch (_) {}
  }
  return {
    configured: Boolean(getUrl()),
    connected,
    lastError,
    queueDepth: usagePending.size + tokenOps.length,
    totalFlushed,
    counts,
  };
}

async function viewAll() {
  if (!pool) {
    const ok = await initNeon();
    if (!ok) return { ok: false, error: lastError || 'Neon not configured' };
  }
  try {
    const tokens = await pool.query('SELECT id, alias, status, substr(token, 1, 8) AS token_preview FROM tokens ORDER BY id');
    const sessions = await pool.query('SELECT COUNT(*) AS n FROM sessions');
    const usage = await pool.query('SELECT date, model, scope_hash, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, total_tokens, cost, requests FROM token_usage ORDER BY date DESC LIMIT 50');
    const totals = await pool.query('SELECT COUNT(*) AS n, COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(total_tokens),0) AS total_tokens, COALESCE(SUM(cost),0) AS cost FROM token_usage');
    return { ok: true, tokens: tokens.rows, sessions: sessions.rows[0].n, token_usage_sample: usage.rows, token_usage_totals: totals.rows[0] };
  } catch (e) {
    lastError = e.message;
    return { ok: false, error: e.message };
  }
}

module.exports = { initNeon, enqueueUsageDelta, enqueueTokenOp, flush, uploadAll, getStatus, viewAll };
