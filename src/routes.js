const path = require('path');
const express = require('express');
const nunjucks = require('nunjucks');
const multer = require('multer');
const crypto = require('crypto');

const config = require('./config');
const { getTokens, getToken, pickToken, addToken, deleteToken, getAuthToken, initDb } = require('./db');
const { getUsageStats, cacheSource } = require('./usage');
const { uploadFile, getFileContent } = require('./api');
const { countTokens } = require('./tokenizer');
const {
  handleChat, resolveModel, displayModel, formatAnthropicResponse, convertAnthropicMessages,
  isThinkingEnabled, messagesText, setKeyNameReq,
} = require('./chat');
const cookies = require('./cookies');
const {
  realIpMiddleware, requestIdMiddleware, bodyLimitMiddleware, installErrorHandler,
} = require('./middleware');
const { contextWindowTokens, maxOutputTokens } = require('./prompt');

const SESSIONS = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const loginFails = { count: 0, lockedUntil: 0 };

function getApiKey(req) {
  const auth = req.headers.authorization || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (auth) return auth;
  return apiKeyHeader;
}

function checkKey(req) {
  const key = getApiKey(req) || '';
  const a = Buffer.from(key);
  const b = Buffer.from(config.apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getCurrentAdmin(req) {
  const sid = req.cookies.session_id;
  const row = sid ? SESSIONS.get(sid) : null;
  if (!sid || !row || Date.now() - row > SESSION_TTL) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  SESSIONS.set(sid, Date.now());
  const origin = req.headers.origin || '';
  if (origin) {
    let netloc = '';
    try { netloc = new URL(origin).host; } catch (_) {}
    if (netloc && netloc !== (req.headers.host || '')) {
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    }
  }
  return 'admin';
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  const env = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
    express: app,
    noCache: true,
  });
  env.addFilter('comma', (v) => Number(v ?? 0).toLocaleString('en-US'));
  env.addFilter('fixed', (v, d) => Number(v ?? 0).toFixed(d));
  env.addFilter('head', (v, n) => String(v ?? '').slice(0, n));
  env.addFilter('tail', (v, n) => String(v ?? '').slice(-n));
  env.addFilter('dateShort', (v) => (v && String(v).length >= 5 ? String(v).slice(5) : v));

  app.use(realIpMiddleware);
  app.use(requestIdMiddleware);
  app.use(bodyLimitMiddleware(32 * 1024 * 1024));
  app.use(express.json({ limit: '32mb' }));
  app.use(express.urlencoded({ extended: true, limit: '32mb' }));
  app.use(require('cookie-parser')());
  app.use('/static', express.static(path.join(__dirname, '..', 'static')));

  const uploadParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

  const renderAuthRedirect = (res) => res.status(200).send("<meta http-equiv='refresh' content='0;url=/login'>");

  // ---------- API ----------
  app.post('/v1/chat/completions', async (req, res) => {
    if (!checkKey(req)) return res.status(401).json({ error: 'Invalid API key' });
    const body = req.body || {};
    const messages = body.messages || [];
    const model = resolveModel(body.model);
    const thinking = isThinkingEnabled(body, req);
    const search = Boolean(body.search);
    const stream = Boolean(body.stream);
    const tools = body.tools || null;
    const streamOptions = body.stream_options || {};
    const includeUsage = Boolean(streamOptions.include_usage);
    try {
      console.log(`chat completions model=${body.model} stream=${stream} include_usage=${includeUsage} msgs=${messages.length} client_est=${await countTokens(messagesText(messages))} tools=${tools ? 'yes' : 'no'}`);
    } catch (_) {}
    const result = await handleChat({ messages, model, thinking, search, stream, tools, scope: getApiKey(req), includeUsage, reqModel: body.model, req });
    if (result.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      try {
        for await (const chunk of result.body) res.write(chunk);
      } catch (e) {
        console.error('stream write failed', e);
      }
      return res.end();
    }
    res.status(result.status).json(result.body);
  });

  app.post('/v1/responses', async (req, res) => {
    if (!checkKey(req)) return res.status(401).json({ error: 'Invalid API key' });
    const body = req.body || {};
    const model = resolveModel(body.model);
    let inputs = body.input || [];
    if (typeof inputs === 'string') inputs = [inputs];
    else if (!Array.isArray(inputs)) inputs = [inputs];

    const messages = [];
    for (const item of inputs) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      const role = item.role || 'user';
      const content = item.content || [];
      let msgContent;
      if (typeof content === 'string') msgContent = content;
      else {
        msgContent = [];
        for (const c of content) {
          if (c.type === 'input_text') msgContent.push({ type: 'text', text: c.text });
          else if (c.type === 'input_file') msgContent.push({ type: 'file', file_id: c.file_id });
          else msgContent.push(c);
        }
      }
      messages.push({ role, content: msgContent });
    }

    const thinking = isThinkingEnabled(body, req);
    const search = Boolean(body.search);
    const stream = Boolean(body.stream);
    const tools = body.tools || null;
    const streamOptions = body.stream_options || {};
    const includeUsage = Boolean(streamOptions.include_usage);

    const result = await handleChat({ messages, model, thinking, search, stream, tools, scope: getApiKey(req), includeUsage, endpoint: '/v1/responses', reqModel: body.model, req });
    if (result.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      for await (const chunk of result.body) res.write(chunk);
      return res.end();
    }
    if (result.body && Array.isArray(result.body.choices)) {
      const message = result.body.choices[0].message;
      const outContent = [];
      if (message.content) outContent.push({ type: 'text', text: message.content });
      if (message.tool_calls) {
        for (const tc of message.tool_calls) outContent.push({ type: 'tool_call', id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      const msgOutput = { type: 'message', role: 'assistant', content: outContent };
      if (message.reasoning_content) msgOutput.reasoning_content = message.reasoning_content;
      return res.json({
        id: result.body.id,
        object: 'response',
        model: result.body.model,
        output: [msgOutput],
        usage: result.body.usage || {},
      });
    }
    res.status(result.status).json(result.body);
  });

  app.post(['/v1/messages', '/messages'], async (req, res) => {
    if (!checkKey(req)) return res.status(401).json({ error: 'Invalid API key' });
    const body = req.body || {};
    const system = body.system || '';
    const messages = body.messages || [];
    const model = resolveModel(body.model);
    const thinking = isThinkingEnabled(body, req);
    const stream = Boolean(body.stream);
    const tools = body.tools || [];

    const openaiMsgs = [];
    if (system) {
      let systemStr = typeof system === 'string' ? system : '';
      if (Array.isArray(system)) systemStr = system.filter((c) => c && typeof c === 'object' && c.type === 'text').map((c) => c.text || '').join(' ');
      if (systemStr) openaiMsgs.push({ role: 'system', content: systemStr });
    }

    openaiMsgs.push(...convertAnthropicMessages(messages));

    const openaiTools = [];
    for (const t of tools) {
      if (t.type === 'function') {
        openaiTools.push({ type: 'function', function: { name: t.name, description: t.description || 'NO DESCRIPTION', parameters: t.input_schema || {} } });
      } else if ('name' in t) {
        openaiTools.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || t.parameters || {} } });
      }
    }

    const outputConfig = body.output_config;
    if (outputConfig && typeof outputConfig === 'object' && outputConfig.format && outputConfig.format.type === 'json_schema') {
      const jsonSchema = outputConfig.format.schema;
      if (jsonSchema) openaiMsgs.unshift({ role: 'system', content: `You MUST return valid JSON adhering strictly to this JSON Schema:\n${JSON.stringify(jsonSchema)}` });
    }

    const reqModel = body.model;
    if (stream) {
      const result = await handleChat({ messages: openaiMsgs, model, thinking, search: false, stream: true, tools: openaiTools.length ? openaiTools : null, isAnthropic: true, reqModel, scope: getApiKey(req), req });
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      for await (const chunk of result.body) res.write(chunk);
      return res.end();
    }
    const result = await handleChat({ messages: openaiMsgs, model, thinking, search: false, stream: false, tools: openaiTools.length ? openaiTools : null, isAnthropic: true, reqModel, scope: getApiKey(req), req });
    if (result.body && Array.isArray(result.body.choices)) {
      return res.json(formatAnthropicResponse(result.body, result.body.model || reqModel));
    }
    res.status(result.status).json(result.body);
  });

  const listModels = (req, res) => {
    if (!checkKey(req)) return res.status(401).json({ error: 'Invalid API key' });
    const baseModels = [
      {
        id: 'deepseek-v4.1-flash',
        object: 'model',
        type: 'model',
        name: 'deepseek-v4.1-flash',
        display_name: 'DeepSeek V4.1 Flash',
        created: 1785456000,
        created_at: '2026-07-31T00:00:00Z',
        owned_by: 'deeperseeker',
        context_window: contextWindowTokens(),
        max_output_tokens: maxOutputTokens(),
        capabilities: {
          batch: { supported: true },
          code_execution: { supported: true },
          image_input: { supported: true },
          pdf_input: { supported: true },
          structured_outputs: { supported: true },
          thinking: { supported: true, types: { enabled: { supported: true }, adaptive: { supported: true } } },
          effort: { supported: true, low: { supported: true }, medium: { supported: true } },
          context_management: { clear_thinking_20251015: { supported: true }, compact_20260112: { supported: true }, supported: true },
        },
      },
    ];
    const aliases = [];
    for (const m of baseModels) {
      const short = { ...m, id: 'v4.1flash', name: 'v4.1flash', display_name: 'DeepSeek V4.1 Flash (short id)' };
      aliases.push(short);
      aliases.push({ ...m, id: 'anthropic/claude-v4.1flash', name: 'anthropic/claude-v4.1flash', display_name: 'Claude ' + m.display_name });
    }
    const allModels = [...baseModels, ...aliases];
    res.json({ object: 'list', data: allModels, has_more: false, first_id: allModels[0].id, last_id: allModels[allModels.length - 1].id });
  };
  app.get(['/v1/models', '/models'], listModels);

  app.get('/v1/usage', (req, res) => {
    if (!checkKey(req)) return res.status(401).json({ error: 'Invalid API key' });
    let days = parseInt(req.query.days || '30', 10);
    if (isNaN(days)) days = 30;
    res.json(getUsageStats(days));
  });

  app.post(['/v1/files', '/v1/files/upload'], uploadParser.single('file'), async (req, res) => {
    if (!checkKey(req)) return res.status(401).json({ error: 'Invalid API key' });
    const tokId = pickToken();
    if (!tokId) return res.status(503).json({ error: 'No tokens available' });
    const tok = getToken(tokId);
    if (!tok) return res.status(503).json({ error: 'Token not found' });
    setKeyNameReq(req, tok.alias);
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (req.file.size > 25 * 1024 * 1024) return res.status(413).json({ error: 'File too large' });
    let fileInfo = null;
    for await (const [statusTag, data] of uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, tok.token)) {
      if (statusTag === 'success') { fileInfo = data; break; }
    }
    if (!fileInfo) return res.status(500).json({ error: 'Upload failed' });
    if (req.path.startsWith('/v1/files/upload')) {
      return res.json({ id: fileInfo.file_id, type: 'file', filename: req.file.originalname, size: fileInfo.size, created_at: fileInfo.anthropic_timestamp });
    }
    res.json({ id: fileInfo.file_id, object: 'file', bytes: fileInfo.size, created_at: fileInfo.openai_timestamp, filename: req.file.originalname, purpose: 'answers' });
  });

  const filesContent = async (req, res) => {
    if (!checkKey(req)) return res.status(401).json({ error: 'Invalid API key' });
    const tokId = pickToken();
    if (!tokId) return res.status(503).json({ error: 'No tokens available' });
    const tok = getToken(tokId);
    if (!tok) return res.status(503).json({ error: 'Token not found' });
    setKeyNameReq(req, tok.alias);
    const gen = getFileContent(tok.token, req.params.file_id);
    let mime;
    try {
      mime = (await gen.next()).value;
    } catch (e) {
      return res.status(502).json({ error: 'File fetch failed' });
    }
    if (mime === undefined) return res.status(404).json({ error: 'File not found' });
    res.setHeader('content-type', mime || 'application/octet-stream');
    for await (const chunk of gen) res.write(chunk);
    res.end();
  };
  app.get('/v1/files/:file_id/content', filesContent);
  app.get('/v1/files/:file_id', filesContent);

  // ---------- Auth + dashboard ----------
  app.get('/login', (req, res) => res.render('login.html', { error: null }));

  app.post('/login', (req, res) => {
    const { username = '', password = '' } = req.body || {};
    if (Date.now() < loginFails.lockedUntil) {
      return res.render('login.html', { error: 'Too many attempts. Try again later.' });
    }
    const userOk = Buffer.from(username).length === Buffer.from(config.adminUser).length && crypto.timingSafeEqual(Buffer.from(username), Buffer.from(config.adminUser));
    const passOk = Buffer.from(password).length === Buffer.from(config.adminPassword).length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(config.adminPassword));
    if (userOk && passOk) {
      loginFails.count = 0;
      const sid = crypto.randomUUID();
      SESSIONS.set(sid, Date.now());
      res.cookie('session_id', sid, { httpOnly: true, sameSite: 'lax' });
      return res.send("<meta http-equiv='refresh' content='0;url=/dashboard'>");
    }
    loginFails.count += 1;
    if (loginFails.count >= 5) {
      loginFails.lockedUntil = Date.now() + 300000;
      loginFails.count = 0;
    }
    res.render('login.html', { error: 'Invalid username or password' });
  });

  app.get('/logout', (req, res) => {
    const sid = req.cookies.session_id;
    if (sid) SESSIONS.delete(sid);
    res.clearCookie('session_id');
    res.send("<meta http-equiv='refresh' content='0;url=/login'>");
  });

  const dashboardHandler = async (req, res) => {
    try {
      getCurrentAdmin(req);
    } catch (e) {
      return res.send("<meta http-equiv='refresh' content='0;url=/login'>");
    }
    const tokens = getTokens();
    let days = parseInt(req.query.days || '14', 10);
    if (isNaN(days)) days = 14;
    days = Math.max(2, Math.min(days, 90));
    let usage;
    try { usage = getUsageStats(days); } catch (_) { usage = { object: 'list', days, data: [], totals: {} }; }
    const rows = usage.data || [];
    const usageMax = Math.max(...rows.map((r) => r.total_tokens || 0), 0);
    const now = new Date();
    let neonStatus = null;
    try {
      neonStatus = await Promise.race([
        require('./neon').getStatus(),
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ]);
    } catch (_) {}
    res.render('dashboard.html', {
      tokens, usage, usageMax, days, neonStatus,
      today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      now: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      cache_source: cacheSource(),
    });
  };
  app.get('/dashboard', dashboardHandler);
  app.get('/', dashboardHandler);

  app.post('/tokens/add', (req, res) => {
    try { getCurrentAdmin(req); } catch (e) { return renderAuthRedirect(res); }
    let { auth_token = '', alias = '' } = req.body || {};
    auth_token = String(auth_token).trim().replace(/^['"]+|['"]+$/g, '');
    alias = String(alias).trim() || null;
    if (auth_token) addToken(auth_token, alias);
    res.send("<meta http-equiv='refresh' content='0;url=/dashboard'>");
  });

  app.post('/tokens/:token_id/delete', (req, res) => {
    try { getCurrentAdmin(req); } catch (e) { return renderAuthRedirect(res); }
    deleteToken(parseInt(req.params.token_id, 10));
    res.send("<meta http-equiv='refresh' content='0;url=/dashboard'>");
  });

  // ---------- Neon cloud sync admin ----------
  const neon = require('./neon');

  app.post('/admin/neon/upload-all', async (req, res) => {
    try { getCurrentAdmin(req); } catch (e) { return renderAuthRedirect(res); }
    const result = await neon.uploadAll();
    res.json(result);
  });

  app.get('/admin/neon/status', (req, res) => {
    try { getCurrentAdmin(req); } catch (e) { return res.status(401).json({ error: 'unauthorized' }); }
    neon.getStatus().then((s) => res.json(s)).catch((e) => res.status(500).json({ error: e.message }));
  });

  app.get('/admin/neon/view', async (req, res) => {
    try { getCurrentAdmin(req); } catch (e) { return res.status(401).json({ error: 'unauthorized' }); }
    const result = await neon.viewAll();
    res.status(result.ok ? 200 : 503).json(result);
  });

  app.get('/health', (req, res) => {
    const active = getTokens().filter((t) => t.status === 'ACTIVE').length;
    const cookiesValid = cookies.cookiesValidNow();
    const ok = active > 0;
    const data = { status: ok ? 'ok' : 'degraded' };
    if (checkKey(req)) {
      data.active_tokens = active;
      data.cookies_valid = cookiesValid;
    }
    res.status(ok ? 200 : 503).json(data);
  });

  installErrorHandler(app);
  return app;
}

module.exports = { createApp };
