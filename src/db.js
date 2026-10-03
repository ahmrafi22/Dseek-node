const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

let db = null;

function getDb() {
  if (!db) {
    db = new Database(config.dbPath, { timeout: 30000 });
    try {
      db.pragma('journal_mode = WAL');
    } catch (_) {}
  }
  return db;
}

const MAX_SESSIONS = parseInt(process.env.DEEPSEEKER_MAX_SESSIONS || '20000', 10);
const PRUNE_EVERY = parseInt(process.env.DEEPSEEKER_PRUNE_EVERY || '500', 10);
let saveCounter = 0;

function initDb() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT,
        token TEXT,
        status TEXT DEFAULT 'ACTIVE'
    );
    CREATE TABLE IF NOT EXISTS sessions (
        signature TEXT PRIMARY KEY,
        token_id INTEGER,
        deepseek_session_id TEXT,
        parent_message_id INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_map (
        old_session TEXT PRIMARY KEY,
        new_session TEXT,
        token_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS token_usage (
        date TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        scope_hash TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, model, scope_hash)
    );
  `);
  try {
    pruneSessions();
  } catch (e) {
    console.error('Startup session pruning failed (non-fatal)', e);
  }
}

function pruneSessions() {
  const conn = getDb();
  const deleted = conn
    .prepare('DELETE FROM sessions WHERE rowid NOT IN (SELECT rowid FROM sessions ORDER BY rowid DESC LIMIT ?)')
    .run(MAX_SESSIONS).changes;
  const deletedMap = conn
    .prepare("DELETE FROM session_map WHERE created_at < datetime('now', '-7 days')")
    .run().changes;
  if (deleted || deletedMap) {
    console.log(`Pruned ${deleted} session signature(s) and ${deletedMap} stale session_map row(s)`);
  }
}

// ---- tokens ----
function getAuthToken() {
  const row = getDb().prepare('SELECT token FROM tokens LIMIT 1').get();
  return row ? row.token : null;
}

function addToken(token, alias = null) {
  const conn = getDb();
  const first = conn.prepare('SELECT 1 FROM tokens WHERE id = 1').get();
  let nextId = 1;
  if (first) {
    const row = conn
      .prepare(`SELECT min(t1.id + 1) AS n FROM tokens t1 LEFT JOIN tokens t2 ON t1.id + 1 = t2.id WHERE t2.id IS NULL`)
      .get();
    nextId = row && row.n ? row.n : 1;
  }
  conn.prepare("INSERT INTO tokens (id, alias, token, status) VALUES (?, ?, ?, 'ACTIVE')").run(nextId, alias, token);
  try { require('./neon').enqueueTokenOp('upsert', { id: nextId, alias, token, status: 'ACTIVE' }); } catch (_) {}
}

function getTokens() {
  return getDb().prepare('SELECT id, alias, token, status FROM tokens').all().map((r) => ({
    id: r.id, alias: r.alias, token: r.token, status: r.status,
  }));
}

function getToken(tokenId) {
  const r = getDb().prepare('SELECT id, alias, token, status FROM tokens WHERE id = ?').get(tokenId);
  return r ? { id: r.id, alias: r.alias, token: r.token, status: r.status } : null;
}

function deleteToken(tokenId) {
  getDb().prepare('DELETE FROM tokens WHERE id = ?').run(tokenId);
  try { require('./neon').enqueueTokenOp('delete', { id: tokenId }); } catch (_) {}
}

function pickToken() {
  const row = getDb().prepare("SELECT id FROM tokens WHERE status = 'ACTIVE' ORDER BY RANDOM() LIMIT 1").get();
  if (row) return row.id;
  const any = getDb().prepare('SELECT id FROM tokens ORDER BY id LIMIT 1').get();
  return any ? any.id : null;
}

function markLimited(tokenId) {
  console.warn(`Token #${tokenId} marked RATE_LIMITED`);
  const prev = getDb().prepare('SELECT status FROM tokens WHERE id = ?').get(tokenId);
  getDb().prepare('UPDATE tokens SET status = ? WHERE id = ?').run('RATE_LIMITED', tokenId);
  if (prev && prev.status !== 'RATE_LIMITED') {
    try {
      const row = getDb().prepare('SELECT id, alias, token, status FROM tokens WHERE id = ?').get(tokenId);
      if (row) require('./neon').enqueueTokenOp('upsert', row);
    } catch (_) {}
  }
}

function markActive(tokenId) {
  const prev = getDb().prepare('SELECT status FROM tokens WHERE id = ?').get(tokenId);
  getDb().prepare('UPDATE tokens SET status = ? WHERE id = ?').run('ACTIVE', tokenId);
  if (prev && prev.status !== 'ACTIVE') {
    try {
      const row = getDb().prepare('SELECT id, alias, token, status FROM tokens WHERE id = ?').get(tokenId);
      if (row) require('./neon').enqueueTokenOp('upsert', row);
    } catch (_) {}
  }
}

// ---- sessions ----
function findSession(sig) {
  const row = getDb().prepare('SELECT token_id, deepseek_session_id, parent_message_id FROM sessions WHERE signature = ?').get(sig);
  return row ? { token_id: row.token_id, session_id: row.deepseek_session_id, parent_message_id: row.parent_message_id } : null;
}

function saveSession(sig, tokenId, sessionId, parentMessageId = 0) {
  getDb()
    .prepare('INSERT OR REPLACE INTO sessions (signature, token_id, deepseek_session_id, parent_message_id) VALUES (?, ?, ?, ?)')
    .run(sig, tokenId, sessionId, parentMessageId);
  saveCounter += 1;
  if (saveCounter >= PRUNE_EVERY) {
    saveCounter = 0;
    try { pruneSessions(); } catch (e) { console.error('Session pruning failed (non-fatal)', e); }
  }
}

function deleteSession(sig) {
  getDb().prepare('DELETE FROM sessions WHERE signature = ?').run(sig);
}

function nextParent(parentMessageId) {
  return parentMessageId + 2;
}

function deleteSessionsForChat(tokenId, sessionId) {
  getDb().prepare('DELETE FROM sessions WHERE token_id = ? AND deepseek_session_id = ?').run(tokenId, sessionId);
}

module.exports = {
  getDb, initDb, pruneSessions, getAuthToken, addToken, getTokens, getToken, deleteToken,
  pickToken, markLimited, markActive, findSession, saveSession, deleteSession, nextParent,
  deleteSessionsForChat,
};
