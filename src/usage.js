const crypto = require('crypto');
const { getDb } = require('./db');
const { countTokens } = require('./tokenizer');

// Rates (per 1M tokens) for the single default model.
const DEEPSEEK_TARIFFS = {
  'deepseek-v4.1-flash': {
    cache_miss_input: 0.15,
    cache_hit_input: 0.003,
    output_generation: 0.60,
  },
};

const _PROMPT_PREFIX_CACHE = new Map();
const PROMPT_PREFIX_CACHE_MAX = parseInt(process.env.DEEPSEEKER_PREFIX_CACHE_MAX || '2048', 10);
const _PREFIX_STORE_CHARS = 32768;
const _PREFIX_SCAN_CHARS = 32768;

const _ACCUMULATED_SEEN = new Map();
const ACCUMULATED_SEEN_MAX = parseInt(process.env.DEEPSEEKER_ACCUMULATED_SEEN_MAX || '4096', 10);

function assumedCacheSpec() {
  const raw = (process.env.DEEPSEEKER_ASSUMED_CACHE_RATE || '0').trim();
  if (raw.includes('-')) {
    const [loS, hiS] = raw.split('-', 2);
    let lo = parseFloat(loS);
    let hi = parseFloat(hiS);
    if (isNaN(lo) || isNaN(hi)) return [0.0, 0.0];
    lo = Math.max(0, Math.min(lo, 0.999));
    hi = Math.max(0, Math.min(hi, 0.999));
    if (hi < lo) [lo, hi] = [hi, lo];
    return [lo, hi];
  }
  let v = parseFloat(raw);
  if (isNaN(v)) v = 0.0;
  v = Math.max(0, Math.min(v, 0.999));
  return [v, v];
}

function assumedCacheRate() {
  const [lo, hi] = assumedCacheSpec();
  if (hi <= 0) return 0.0;
  if (hi === lo) return lo;
  return lo + Math.random() * (hi - lo);
}

function cacheSource() {
  const [lo, hi] = assumedCacheSpec();
  if (hi <= 0) return 'heuristic';
  if (hi === lo) return `assumed ${lo.toFixed(3)}`;
  return `assumed ${lo.toFixed(2)}-${hi.toFixed(2)}`;
}

function scopeHash(scope) {
  return crypto.createHash('sha256').update(String(scope || ''), 'utf8').digest('hex').slice(0, 16);
}

async function estimateCachedTokens(sessionKey, promptText, promptTokens) {
  promptText = String(promptText || '');
  promptTokens = Math.max(0, parseInt(promptTokens || 0, 10));
  const assumed = assumedCacheRate();
  if (assumed > 0 && promptTokens > 0) {
    return Math.max(0, Math.min(Math.floor(promptTokens * assumed), promptTokens));
  }
  let prev = null;
  if (_PROMPT_PREFIX_CACHE.has(sessionKey)) {
    prev = _PROMPT_PREFIX_CACHE.get(sessionKey);
    _PROMPT_PREFIX_CACHE.delete(sessionKey);
    _PROMPT_PREFIX_CACHE.set(sessionKey, prev);
  }
  if (_PROMPT_PREFIX_CACHE.size >= PROMPT_PREFIX_CACHE_MAX && !_PROMPT_PREFIX_CACHE.has(sessionKey)) {
    const oldest = _PROMPT_PREFIX_CACHE.keys().next().value;
    _PROMPT_PREFIX_CACHE.delete(oldest);
  }
  _PROMPT_PREFIX_CACHE.set(sessionKey, promptText.slice(0, _PREFIX_STORE_CHARS));
  if (!prev || !promptText || promptTokens <= 0) return 0;
  const cur = promptText.slice(0, _PREFIX_SCAN_CHARS);
  const limit = Math.min(prev.length, cur.length);
  let n = 0;
  const step = 4096;
  while (n < limit) {
    const chunk = Math.min(step, limit - n);
    if (prev.slice(n, n + chunk) !== cur.slice(n, n + chunk)) {
      for (let i = n; i < n + chunk; i++) {
        if (prev[i] !== cur[i]) { n = i; break; }
      }
      break;
    }
    n += chunk;
  }
  if (n <= 0) return 0;
  try {
    const cached = await countTokens(cur.slice(0, n));
    return Math.max(0, Math.min(cached, promptTokens));
  } catch (_) {
    return 0;
  }
}

function accumulatedTurnUsage(sessionKey, terminalValue) {
  const cur = parseInt(terminalValue, 10);
  if (isNaN(cur)) return null;
  let prev = 0;
  if (sessionKey) {
    if (_ACCUMULATED_SEEN.has(sessionKey)) {
      prev = _ACCUMULATED_SEEN.get(sessionKey);
      _ACCUMULATED_SEEN.delete(sessionKey);
    }
    if (_ACCUMULATED_SEEN.size >= ACCUMULATED_SEEN_MAX && !_ACCUMULATED_SEEN.has(sessionKey)) {
      _ACCUMULATED_SEEN.delete(_ACCUMULATED_SEEN.keys().next().value);
    }
    _ACCUMULATED_SEEN.set(sessionKey, cur);
  }
  if (cur <= 0) return null;
  const delta = cur - prev;
  return delta > 0 ? delta : null;
}

async function computeUsage(promptTokens, cachedTokens, completionText, upstreamCompletion = null, reasoningText = null) {
  promptTokens = Math.max(0, parseInt(promptTokens || 0, 10));
  cachedTokens = Math.max(0, Math.min(parseInt(cachedTokens || 0, 10), promptTokens));
  let completionTokens;
  let completionSource;
  if (upstreamCompletion != null) {
    const up = parseInt(upstreamCompletion, 10);
    if (!isNaN(up)) {
      completionTokens = Math.max(0, up);
      completionSource = 'upstream';
    } else {
      completionTokens = await countTokens(completionText || '');
      completionSource = 'estimated';
    }
  } else {
    completionTokens = await countTokens(completionText || '');
    completionSource = 'estimated';
  }
  let reasoningTokens = 0;
  try {
    reasoningTokens = reasoningText ? await countTokens(reasoningText) : 0;
  } catch (_) {
    reasoningTokens = 0;
  }
  const totalTokens = promptTokens + completionTokens;
  const tariff = DEEPSEEK_TARIFFS['deepseek-v4.1-flash'];
  const missTokens = promptTokens - cachedTokens;
  const cost = (missTokens / 1e6) * tariff.cache_miss_input + (cachedTokens / 1e6) * tariff.cache_hit_input + (completionTokens / 1e6) * tariff.output_generation;
  return {
    prompt_tokens: promptTokens,
    cached_tokens: cachedTokens,
    completion_tokens: completionTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
    cost: Math.round(cost * 1e6) / 1e6,
    completion_source: completionSource,
    cache_source: cacheSource(),
  };
}

function recordUsage(model, scope, usage) {
  try {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    getDb()
      .prepare(
        `INSERT INTO token_usage (date, model, scope_hash, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens, total_tokens, cost, requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(date, model, scope_hash) DO UPDATE SET
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           cached_tokens = cached_tokens + excluded.cached_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens,
           reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
           total_tokens = total_tokens + excluded.total_tokens,
           cost = cost + excluded.cost,
           requests = requests + 1`
      )
      .run(day, model || '', scopeHash(scope), usage.prompt_tokens | 0, usage.cached_tokens | 0, usage.completion_tokens | 0, usage.reasoning_tokens | 0, usage.total_tokens | 0, usage.cost || 0);
    try {
      require('./neon').enqueueUsageDelta({
        date: day, model: model || '', scope_hash: scopeHash(scope),
        prompt_tokens: usage.prompt_tokens | 0, cached_tokens: usage.cached_tokens | 0,
        completion_tokens: usage.completion_tokens | 0, reasoning_tokens: usage.reasoning_tokens | 0,
        total_tokens: usage.total_tokens | 0, cost: usage.cost || 0, requests: 1,
      });
    } catch (_) {}
  } catch (e) {
    console.error('record_usage failed (non-fatal)', e);
  }
}

function getUsageStats(days = 30) {
  let d = parseInt(days, 10);
  if (isNaN(d)) d = 30;
  d = Math.max(1, Math.min(d, 365));
  const cutoffDate = new Date(Date.now() - (d - 1) * 864e5);
  const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;
  const rows = getDb()
    .prepare(
      `SELECT date, model, SUM(prompt_tokens) AS p, SUM(cached_tokens) AS c, SUM(completion_tokens) AS comp, SUM(reasoning_tokens) AS r, SUM(total_tokens) AS t, SUM(cost) AS cost, SUM(requests) AS reqs
       FROM token_usage WHERE date >= ? GROUP BY date, model ORDER BY date DESC, model ASC`
    )
    .all(cutoff);
  const data = [];
  const totals = { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0, cost: 0.0, requests: 0 };
  for (const r of rows) {
    const row = {
      date: r.date, model: r.model, prompt_tokens: r.p || 0, cached_tokens: r.c || 0, completion_tokens: r.comp || 0,
      reasoning_tokens: r.r || 0, total_tokens: r.t || 0, cost: Math.round((r.cost || 0) * 1e6) / 1e6, requests: r.reqs || 0,
    };
    data.push(row);
    for (const k of Object.keys(totals)) totals[k] += row[k];
  }
  totals.cost = Math.round(totals.cost * 1e6) / 1e6;
  return { object: 'list', days: d, data, totals, cache_source: cacheSource() };
}

module.exports = {
  DEEPSEEK_TARIFFS, cacheSource, scopeHash, assumedCacheSpec, assumedCacheRate,
  estimateCachedTokens, accumulatedTurnUsage, computeUsage, recordUsage, getUsageStats,
};
