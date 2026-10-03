const crypto = require('crypto');
const {
  getAuthToken, getToken, pickToken, markLimited, markActive, findSession, saveSession,
  deleteSessionsForChat, nextParent,
} = require('./db');
const {
  cacheSource, computeUsage, recordUsage, estimateCachedTokens, accumulatedTurnUsage, scopeHash,
  DEEPSEEK_TARIFFS,
} = require('./usage');
const { countTokens } = require('./tokenizer');
const { createNewChat, sendMessage } = require('./api');
const {
  buildPrompt, buildSummaryRequestPrompt, stripSummaryTags, needsRollover, extractAndUploadFiles,
  generateSignatureSync, generateSignature, messagesPlainText, contextWindowTokens, maxOutputTokens,
  MAX_SUMMARY_TOKENS,
} = require('./prompt');
const { parseTools, StreamToolParser } = require('./tools');

// ---- models ----
const PUBLIC_MODEL = 'deepseek-v4.1-flash';
const SINGLE_MODEL = 'v4.1flash';

function resolveModel(modelRaw) {
  return SINGLE_MODEL;
}

function displayModel(reqModel, model) {
  return reqModel || PUBLIC_MODEL;
}

// ---- alias sanitization (dashboard token alias logging) ----
const ALIAS_MAX_LEN = 64;
const ALIAS_INVISIBLE = new Set([0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x2800, 0x3164, 0xffa0]);
const ALIAS_STRIP_CATS = new Set(); // Unicode categories; JS lacks category API, approximate via regex below
function sanitizeAlias(name) {
  if (!name) return null;
  let cleaned = '';
  for (const ch of String(name)) {
    const cp = ch.codePointAt(0);
    if (ALIAS_INVISIBLE.has(cp)) continue;
    if (cp >= 0xfdd0 && cp <= 0xfdef) continue;
    if ((cp & 0xffff) === 0xfffe || (cp & 0xffff) === 0xffff) continue;
    // strip control/format/separator chars
    if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufe00-\ufe0f\u180b-\u180d]/.test(ch)) continue;
    cleaned += ch;
  }
  cleaned = cleaned.trim().slice(0, ALIAS_MAX_LEN);
  return cleaned || null;
}

function setKeyNameReq(req, name) {
  if (req) req.keyName = sanitizeAlias(name);
}

function logUsage(endpoint, model, scope, usage, stream = false, note = '', upPrompt = null) {
  try {
    const suffix = note ? ` ${note}` : '';
    const up = upPrompt != null ? ` up=${upPrompt}` : '';
    console.log(
      `usage endpoint=${endpoint} model=${model} stream=${stream} prompt=${usage.prompt_tokens || 0} cached=${usage.cached_tokens || 0}(${usage.cache_source || '?'}) completion=${usage.completion_tokens || 0}(${usage.completion_source || '?'}) reasoning=${usage.reasoning_tokens || 0} total=${usage.total_tokens || 0} cost=${(usage.cost || 0).toFixed(6)} scope=${scopeHash(scope)}${up}${suffix}`
    );
  } catch (_) {}
}

function splitReasoning(text) {
  const match = /<think>\s*([\s\S]*?)\s*<\/think>\s*/.exec(text || '');
  const reasoning = match ? match[1].trim() : null;
  return [reasoning, (text || '').replace(/<think>[\s\S]*?<\/think>/g, '')];
}

function openaiUsagePayload(usage) {
  const payload = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cost: usage.cost,
    prompt_tokens_details: { cached_tokens: usage.cached_tokens || 0 },
  };
  if (usage.reasoning_tokens) payload.completion_tokens_details = { reasoning_tokens: usage.reasoning_tokens };
  return payload;
}

async function turnCompletion(sessionKey, tracker) {
  return accumulatedTurnUsage(sessionKey, (tracker || {}).upstream_completion);
}

function messagesText(messages) {
  return messages
    .map((m) => {
      const c = m.content;
      if (Array.isArray(c)) return c.filter((p) => p && typeof p === 'object' && p.type === 'text').map((p) => p.text || '').join(' ');
      return String(c ?? '');
    })
    .join('\n');
}

async function* holdThinkTags(gen) {
  let carry = '';
  for await (const chunk0 of gen) {
    let chunk = carry + chunk0;
    carry = '';
    let hold = 0;
    for (const tag of ['<think>', '</think>']) {
      for (let i = 1; i < tag.length; i++) {
        if (chunk.endsWith(tag.slice(0, i))) hold = Math.max(hold, i);
      }
    }
    if (hold) {
      carry = chunk.slice(-hold);
      chunk = chunk.slice(0, -hold);
    }
    if (chunk) yield chunk;
  }
  if (carry) yield carry;
}

async function collectResponse(gen) {
  let text = '';
  for await (const chunk of gen) text += chunk;
  return text;
}

async function* preflightStream(gen) {
  let first;
  try {
    first = (await gen.next()).value;
    if (first === undefined) return;
  } catch (e) {
    throw e;
  }
  yield first;
  for await (const chunk of gen) yield chunk;
}

// ---- per-chat + per-signature locks ----
class Mutex {
  constructor() {
    this._locked = false;
    this._queue = [];
  }
  locked() {
    return this._locked;
  }
  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }
    await new Promise((res) => this._queue.push(res));
    return () => this._release();
  }
  _release() {
    const next = this._queue.shift();
    if (next) next();
    else this._locked = false;
  }
}

class OwnedLock {
  constructor(lock) {
    this.lock = lock;
    this.owned = false;
    this._releaseFn = null;
  }
  async acquire() {
    this._releaseFn = await this.lock.acquire();
    this.owned = true;
  }
  release() {
    if (!this.owned) return;
    this.owned = false;
    try { this._releaseFn(); } catch (_) {}
  }
}

const _sigLocks = new Map();
const SIG_LOCKS_MAX = parseInt(process.env.DEEPSEEKER_MAX_SIG_LOCKS || '4096', 10);
const _chatLocks = new Map();
const CHAT_LOCKS_MAX = parseInt(process.env.DEEPSEEKER_MAX_CHAT_LOCKS || '4096', 10);

function takeLock(label, registry, key, maxEntries) {
  let lock = registry.get(key);
  if (lock) {
    registry.delete(key);
    registry.set(key, lock);
    return lock;
  }
  if (registry.size >= maxEntries) {
    for (const [k, v] of registry) {
      if (!v.locked()) { registry.delete(k); break; }
    }
  }
  lock = new Mutex();
  registry.set(key, lock);
  if (registry.size > maxEntries) {
    console.warn(`${label} lock registry over cap: ${registry.size} entries (cap ${maxEntries})`);
  }
  return lock;
}

function chatLock(sessionId) {
  return takeLock('chat', _chatLocks, String(sessionId), CHAT_LOCKS_MAX);
}

async function ownChatLock(sessionId) {
  const token = new OwnedLock(chatLock(sessionId));
  await token.acquire();
  return token;
}

function releaseChatLockStream(gen, owner) {
  return (async function* () {
    try {
      for await (const chunk of gen) yield chunk;
    } finally {
      owner.release();
    }
  })();
}

function apiErrorResponse(e, isAnthropic = false) {
  const m = /HTTP (\d{3}):/.exec(String(e));
  const code = m ? parseInt(m[1], 10) : 502;
  const payload = isAnthropic
    ? { type: 'error', error: { type: 'api_error', message: String(e).slice(0, 500) } }
    : { error: { message: String(e).slice(0, 500), type: 'api_error', code } };
  return { status: Math.max(400, Math.min(599, code || 502)), body: payload };
}

async function handleChat({ messages, model, thinking = false, search = false, stream = false, tools = null, isAnthropic = false, reqModel = null, scope = '', _retried = false, includeUsage = false, endpoint = '/v1/chat/completions', req = null }) {
  const ep = isAnthropic ? '/v1/messages' : endpoint;
  const respModel = displayModel(reqModel, model);
  const authToken = getAuthToken();
  if (!authToken) {
    return { status: 401, body: { error: 'No auth token. Add via dashboard.' } };
  }

  const sig = generateSignatureSync(messages, model, scope);
  let sess = findSession(sig);
  let rolloverSummary = null;

  if (sess) {
    const { token_id: tokenId, session_id: sessionId, parent_message_id: parentMessageId } = sess;
    const tok = getToken(tokenId);
    if (!tok || tok.status === 'RATE_LIMITED') {
      const newTokenId = pickToken();
      if (newTokenId && (!tok || newTokenId !== tokenId)) {
        const newTok = getToken(newTokenId);
        if (newTok) {
          setKeyNameReq(req, newTok.alias);
          let rotOwner = null;
          try {
            deleteSessionsForChat(tokenId, sessionId);
            const newSessionId = await createNewChat(newTok.token);
            rotOwner = await ownChatLock(newSessionId);
            if (await needsRollover(messages)) {
              const scratchChat = await createNewChat(newTok.token);
              const sumPrompt = buildSummaryRequestPrompt(messages);
              const sumTracker = {};
              const summaryGen = sendMessage(scratchChat, newTok.token, await sumPrompt, 0, false, false, [], sumTracker);
              const summaryText = stripSummaryTags(await collectResponse(summaryGen)).slice(0, MAX_SUMMARY_TOKENS * 4);
              const [sumReasoning] = splitReasoning(summaryText);
              const sumUsage = await computeUsage(await countTokens(sumPrompt), 0, summaryText, accumulatedTurnUsage(null, sumTracker.upstream_completion), sumReasoning);
              recordUsage(model, scope, sumUsage);
              logUsage('internal:summary', model, scope, sumUsage, false, 'token-rotation scratch chat');
              rolloverSummary = summaryText;
            }
            const prompt = await buildPrompt(messages, tools || [], model, true, rolloverSummary);
            const fileIds = await extractAndUploadFiles(messages, newTok.token);
            const rotClientTokens = await countTokens(messagesText(messages));
            const rotPromptTokens = await countTokens(prompt);
            const rotCached = await estimateCachedTokens(`${newTokenId}:${newSessionId}`, prompt, rotClientTokens);
            const rotTracker = {};
            let gen = sendMessage(newSessionId, newTok.token, prompt, 0, thinking, search, fileIds, rotTracker);
            gen = await preflightStream(gen);
            if (stream) {
              gen = releaseChatLockStream(gen, rotOwner);
              if (isAnthropic) {
                return { status: 200, stream: true, body: streamAnthropicResponse(gen, model, messages, newTokenId, newSessionId, sig, tools, reqModel, 0, scope, rotTracker, rotClientTokens, rotCached) };
              }
              return { status: 200, stream: true, body: streamResponse(gen, model, messages, newTokenId, newSessionId, sig, tools, 0, scope, rotTracker, rotClientTokens, rotCached, includeUsage, ep) };
            }
            try {
              const respText = await collectResponse(gen);
              markActive(newTokenId);
              const [rotReasoning] = splitReasoning(respText);
              const rotUsage = await computeUsage(rotClientTokens, rotCached, respText, accumulatedTurnUsage(`${newTokenId}:${newSessionId}`, rotTracker.upstream_completion), rotReasoning);
              recordUsage(model, scope, rotUsage);
              logUsage(ep, model, scope, rotUsage, false, 'token-rotation', rotPromptTokens);
              const [parsedTools, cleanText0] = parseTools(respText);
              const cleanText = cleanText0.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/<\/?(?:tool_calls?|invoke|function_call|parameter)[^>]*>/gi, '').trim();
              const nextMessages = [...messages, { role: 'assistant', ...(parsedTools.length ? { tool_calls: parsedTools } : { content: cleanText }) }];
              const nextSig = generateSignatureSync(nextMessages, model, scope);
              saveSession(sig, newTokenId, newSessionId, nextParent(0));
              saveSession(nextSig, newTokenId, newSessionId, nextParent(0));
              if (rotOwner) rotOwner.release();
              return { status: 200, body: await formatResponse(respText, respModel, messages, tools, rotUsage) };
            } catch (e) {
              if (rotOwner) rotOwner.release();
              console.error('Token-rotation request failed:', e);
              if (_retried) return apiErrorResponse(e, isAnthropic);
              return handleChat({ messages, model, thinking, search, stream, tools, isAnthropic, reqModel, scope, _retried: true, includeUsage, endpoint, req });
            }
          } catch (e) {
            if (rotOwner) rotOwner.release();
            console.error(`Token-rotation recovery failed (chat ${sessionId}):`, e);
            if (_retried) return apiErrorResponse(e, isAnthropic);
            return handleChat({ messages, model, thinking, search, stream, tools, isAnthropic, reqModel, scope, _retried: true, includeUsage, endpoint, req });
          }
        }
      }
      return { status: 429, body: { error: { message: 'No active tokens available (all rate limited). Try again later.', type: 'rate_limit_error' } } };
    }
  } else {
    const createLock = takeLock('sig', _sigLocks, sig, SIG_LOCKS_MAX);
    // mutex: acquire then release
    const releaseCreate = await createLock.acquire();
    try {
      sess = findSession(sig);
      if (!sess) {
        const tokenId = pickToken();
        if (!tokenId) return { status: 503, body: { error: 'No tokens available' } };
        const tok = getToken(tokenId);
        if (!tok) return { status: 503, body: { error: 'Token not found' } };
        if (await needsRollover(messages)) {
          const scratchChat = await createNewChat(tok.token);
          const sumPrompt = buildSummaryRequestPrompt(messages);
          const sumTracker = {};
          const summaryGen = sendMessage(scratchChat, tok.token, await sumPrompt, 0, false, false, [], sumTracker);
          const summaryText = stripSummaryTags(await collectResponse(summaryGen)).slice(0, MAX_SUMMARY_TOKENS * 4);
          const [sumReasoning] = splitReasoning(summaryText);
          const sumUsage = await computeUsage(await countTokens(sumPrompt), 0, summaryText, accumulatedTurnUsage(null, sumTracker.upstream_completion), sumReasoning);
          recordUsage(model, scope, sumUsage);
          logUsage('internal:summary', model, scope, sumUsage, false, 'rollover scratch chat');
          rolloverSummary = summaryText;
          console.log(`Context rollover: handoff summary of ~${(await countTokens(rolloverSummary)).toLocaleString()} tokens prepared in scratch chat ${scratchChat}`);
        }
        const sessionId = await createNewChat(tok.token);
        saveSession(sig, tokenId, sessionId, 0);
        sess = { token_id: tokenId, session_id: sessionId, parent_message_id: 0 };
      }
    } finally {
      releaseCreate();
    }
  }

  let tokenId = sess.token_id;
  let sessionId = sess.session_id;
  let parentMessageId = sess.parent_message_id;
  const tok = getToken(tokenId);
  if (!tok) return { status: 503, body: { error: 'Token expired' } };
  setKeyNameReq(req, tok.alias);

  const isFirst = parentMessageId === 0;
  const lockOwner = await ownChatLock(sessionId);
  let lockTransferred = false;
  try {
    const fileIds = await extractAndUploadFiles(messages, tok.token, !isFirst);
    const prompt = await buildPrompt(messages, tools || [], model, isFirst, rolloverSummary);
    const clientTokens = await countTokens(messagesText(messages));
    const promptTokens = await countTokens(prompt);
    const cachedTokens = await estimateCachedTokens(`${tokenId}:${sessionId}`, prompt, clientTokens);
    const tracker = {};

    let gen = sendMessage(sessionId, tok.token, prompt, parentMessageId, thinking, search, fileIds, tracker);
    gen = await preflightStream(gen);
    if (stream) {
      gen = releaseChatLockStream(gen, lockOwner);
      lockTransferred = true;
      if (isAnthropic) {
        return { status: 200, stream: true, body: streamAnthropicResponse(gen, model, messages, tokenId, sessionId, sig, tools, reqModel, parentMessageId, scope, tracker, clientTokens, cachedTokens) };
      }
      return { status: 200, stream: true, body: streamResponse(gen, model, messages, tokenId, sessionId, sig, tools, parentMessageId, scope, tracker, clientTokens, cachedTokens, includeUsage, ep) };
    }
    const respText = await collectResponse(gen);
    markActive(tokenId);
    const [reasoning] = splitReasoning(respText);
    const usage = await computeUsage(clientTokens, cachedTokens, respText, accumulatedTurnUsage(`${tokenId}:${sessionId}`, tracker.upstream_completion), reasoning);
    recordUsage(model, scope, usage);
    logUsage(ep, model, scope, usage, false, '', promptTokens);

    const [parsedTools, cleanText0] = parseTools(respText);
    const cleanText = cleanText0.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/<\/?(?:tool_calls?|invoke|function_call|parameter)[^>]*>/gi, '').trim();
    const nextMessages = [...messages, { role: 'assistant', ...(parsedTools.length ? { tool_calls: parsedTools } : { content: cleanText }) }];
    const nextSig = generateSignatureSync(nextMessages, model, scope);
    saveSession(sig, tokenId, sessionId, nextParent(parentMessageId));
    saveSession(nextSig, tokenId, sessionId, nextParent(parentMessageId));
    return { status: 200, body: await formatResponse(respText, respModel, messages, tools, usage) };
  } catch (e) {
    console.error(`Chat request failed (session ${sessionId}, parent ${parentMessageId}):`, e);
    const m = /HTTP (\d{3}):/.exec(String(e));
    const code = m ? parseInt(m[1], 10) : null;
    if (code === 401 || code === 403 || code === 429) markLimited(tokenId);
    deleteSessionsForChat(tokenId, sessionId);
    if (_retried) return apiErrorResponse(e, isAnthropic);
    if (!(code === 401 || code === 403 || code === 429) && parentMessageId === 0) return apiErrorResponse(e, isAnthropic);
    lockOwner.release();
    return handleChat({ messages, model, thinking, search, stream, tools, isAnthropic, reqModel, scope, _retried: true, includeUsage, endpoint, req });
  } finally {
    if (!lockTransferred) lockOwner.release();
  }
}

async function* streamResponse(gen, model, messages, tokenId, sessionId, sig, tools, parentMessageId = 0, scope = '', usageTracker = null, promptTokens = null, cachedTokens = 0, includeUsage = false, endpoint = '/v1/chat/completions') {
  const parser = new StreamToolParser();
  let fullText = '';
  let isThinking = false;
  let aborted = false;
  let failed = false;
  try {
    for await (const chunk0 of holdThinkTags(gen)) {
      if (!chunk0) continue;
      let chunk = chunk0;
      fullText += chunk;

      if (chunk.includes('<think>')) {
        isThinking = true;
        chunk = chunk.replace('<think>', '').replace(/^\n+/, '');
      }

      let endThinking = false;
      if (chunk.includes('</think>')) {
        isThinking = false;
        endThinking = true;
        const parts = chunk.split('</think>');
        const thinkPart = parts[0];
        chunk = parts.length > 1 ? parts[1].replace(/^\n+/, '') : '';
        if (thinkPart) yield `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: thinkPart } }] })}\n\n`;
      }

      if (isThinking && chunk) {
        yield `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: chunk } }] })}\n\n`;
        continue;
      }

      if (endThinking && !chunk) continue;

      for (const r of parser.feed(chunk)) {
        if ('text' in r) yield `data: ${JSON.stringify({ choices: [{ delta: { content: r.text } }] })}\n\n`;
      }
    }
    markActive(tokenId);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e instanceof GeneratorExit)) {
      aborted = true;
      failed = true;
      throw e;
    }
    failed = true;
    const m = /HTTP (\d{3}):/.exec(String(e));
    const code = m ? parseInt(m[1], 10) : null;
    if (code === 401 || code === 403 || code === 429) markLimited(tokenId);
    console.error('stream_response failed', e);
    try {
      yield `data: ${JSON.stringify({ error: { message: String(e).slice(0, 300) } })}\n\n`;
    } catch (_) {}
  } finally {
    const [parsedTools, cleanText0] = parseTools(fullText);
    const cleanText = cleanText0.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/<\/?(?:tool_calls?|invoke|function_call|parameter)[^>]*>/gi, '').trim();

    if (!failed) {
      const nextMessages = [...messages, { role: 'assistant', ...(parsedTools.length ? { tool_calls: parsedTools } : { content: cleanText }) }];
      const nextSig = generateSignatureSync(nextMessages, model, scope);
      saveSession(sig, tokenId, sessionId, nextParent(parentMessageId));
      saveSession(nextSig, tokenId, sessionId, nextParent(parentMessageId));
    }

    let streamUsage = null;
    try {
      const [streamReasoning] = splitReasoning(fullText);
      const streamPt = promptTokens != null ? promptTokens : await countTokens(messagesText(messages));
      streamUsage = await computeUsage(streamPt, cachedTokens || 0, fullText, accumulatedTurnUsage(`${tokenId}:${sessionId}`, (usageTracker || {}).upstream_completion), streamReasoning);
      if (!failed) {
        recordUsage(model, scope, streamUsage);
        logUsage(endpoint, model, scope, streamUsage, true);
      }
    } catch (e) {
      console.error('stream usage accounting failed (non-fatal)', e);
      streamUsage = null;
    }

    if (!aborted && !failed) {
      try {
        if (!parsedTools.length) {
          for (const r of parser.flush()) {
            if ('text' in r) yield `data: ${JSON.stringify({ choices: [{ delta: { content: r.text } }] })}\n\n`;
          }
        }
        if (parsedTools.length) {
          parsedTools.forEach((tc, i) => {
            const deltaTc = { index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } };
            yield `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [deltaTc] } }] })}\n\n`;
          });
        }
        if (parsedTools.length) {
          yield `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`;
        } else {
          yield `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
        }
        if (includeUsage && streamUsage) {
          yield `data: ${JSON.stringify({ choices: [], usage: openaiUsagePayload(streamUsage) })}\n\n`;
        }
        yield 'data: [DONE]\n\n';
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
  }
}

async function* streamAnthropicResponse(gen, model, messages, tokenId, sessionId, sig, tools, reqModel = null, parentMessageId = 0, scope = '', usageTracker = null, promptTokens = null, cachedTokens = 0) {
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const inTokens = promptTokens != null ? promptTokens : await countTokens(messagesText(messages));
  const modelName = reqModel || model;
  const startEvt = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: modelName, stop_reason: null, stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: cachedTokens || 0 } } })}\n\n`;
  yield startEvt;

  const parser = new StreamToolParser();
  let fullText = '';
  let textBlockStarted = false;
  let blockIndex = 0;
  let aborted = false;
  let failed = false;
  let isThinking = false;

  try {
    for await (const chunk0 of holdThinkTags(gen)) {
      if (!chunk0) continue;
      let chunk = chunk0;
      fullText += chunk;

      if (chunk.includes('<think>')) {
        isThinking = true;
        chunk = chunk.replace('<think>', '').replace(/^\n+/, '');
        yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking' } })}\n\n`;
      }

      let endThinking = false;
      if (chunk.includes('</think>')) {
        isThinking = false;
        endThinking = true;
        const parts = chunk.split('</think>');
        const thinkPart = parts[0];
        chunk = parts.length > 1 ? parts[1].replace(/^\n+/, '') : '';
        if (thinkPart) yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: thinkPart } })}\n\n`;
      }

      if (isThinking && chunk) {
        yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: chunk } })}\n\n`;
        continue;
      }

      if (endThinking) {
        yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`;
        blockIndex += 1;
        if (!chunk) continue;
      }

      for (const r of parser.feed(chunk)) {
        if ('text' in r) {
          if (!textBlockStarted) {
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })}\n\n`;
            textBlockStarted = true;
          }
          yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: r.text } })}\n\n`;
        }
      }
    }
    markActive(tokenId);
  } catch (e) {
    if (e && e.name === 'AbortError') { aborted = true; failed = true; throw e; }
    failed = true;
    const m = /HTTP (\d{3}):/.exec(String(e));
    const code = m ? parseInt(m[1], 10) : null;
    if (code === 401 || code === 403 || code === 429) markLimited(tokenId);
    console.error('stream_anthropic_response failed', e);
    try {
      yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e).slice(0, 300) } })}\n\n`;
    } catch (_) {}
  } finally {
    const [parsedTools, cleanText0] = parseTools(fullText);
    const antUpstreamOut = accumulatedTurnUsage(`${tokenId}:${sessionId}`, (usageTracker || {}).upstream_completion);
    const outTokens = antUpstreamOut != null ? antUpstreamOut : await countTokens(fullText);

    const cleanText = cleanText0.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/<\/?(?:tool_calls?|invoke|function_call|parameter)[^>]*>/gi, '').trim();

    if (!failed) {
      const nextMessages = [...messages, { role: 'assistant', ...(parsedTools.length ? { tool_calls: parsedTools } : { content: cleanText }) }];
      const nextSig = generateSignatureSync(nextMessages, model, scope);
      saveSession(sig, tokenId, sessionId, nextParent(parentMessageId));
      saveSession(nextSig, tokenId, sessionId, nextParent(parentMessageId));
    }

    try {
      const [antReasoning] = splitReasoning(fullText);
      const antUsage = await computeUsage(inTokens, cachedTokens || 0, fullText, antUpstreamOut, antReasoning);
      if (!failed) {
        recordUsage(model, scope, antUsage);
        logUsage('/v1/messages', model, scope, antUsage, true);
      }
    } catch (e) {
      console.error('anthropic stream usage accounting failed (non-fatal)', e);
    }

    const blockIndexLocal = [blockIndex];
    let tailEvents = '';
    const tb = (text) =>
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndexLocal[0], content_block: { type: 'text', text: '' } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndexLocal[0], delta: { type: 'text_delta', text } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndexLocal[0] })}\n\n`;

    if (isThinking) {
      tailEvents += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndexLocal[0] })}\n\n`;
      blockIndexLocal[0] += 1;
    }

    let flushedText = '';
    if (!parsedTools.length) {
      for (const r of parser.flush()) {
        if ('text' in r) flushedText += r.text;
      }
    }

    if (!textBlockStarted && !parsedTools.length && (cleanText || flushedText)) {
      tailEvents += tb(cleanText || flushedText);
    } else if (textBlockStarted && !parsedTools.length) {
      tailEvents += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndexLocal[0] })}\n\n`;
    }

    if (parsedTools.length) {
      for (const tc of parsedTools) {
        const toolInput = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        const jsonStr = JSON.stringify(toolInput);
        tailEvents += `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndexLocal[0], content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } })}\n\n`;
        tailEvents += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndexLocal[0], delta: { type: 'input_json_delta', partial_json: jsonStr } })}\n\n`;
        tailEvents += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndexLocal[0] })}\n\n`;
        blockIndexLocal[0] += 1;
      }
      tailEvents += `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: outTokens } })}\n\n`;
    } else {
      tailEvents += `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outTokens } })}\n\n`;
    }
    tailEvents += `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

    if (!aborted && !failed) {
      try {
        for (const evt of tailEvents.split('\n\n')) {
          if (evt.trim()) yield evt + '\n\n';
        }
      } catch (_) {}
    }
  }
}

async function formatResponse(text, model, messages, tools = null, _usage = null) {
  const [parsedTools, cleanText0] = parseTools(text);
  const [reasoning] = splitReasoning(text);
  const cleanText = cleanText0.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/<\/?(?:tool_calls?|invoke|function_call|parameter)[^>]*>/gi, '').trim();

  let usagePayload;
  if (_usage != null) {
    usagePayload = openaiUsagePayload(_usage);
  } else {
    const inTokens = await countTokens(messagesText(messages));
    const outTokens = await countTokens(text);
    const tariff = DEEPSEEK_TARIFFS['deepseek-v4.1-flash'];
    const cost = (inTokens / 1e6) * tariff.cache_miss_input + (outTokens / 1e6) * tariff.output_generation;
    usagePayload = {
      prompt_tokens: inTokens,
      completion_tokens: outTokens,
      total_tokens: inTokens + outTokens,
      cost: Math.round(cost * 1e6) / 1e6,
      prompt_tokens_details: { cached_tokens: 0 },
    };
  }

  const msgDict = {
    role: 'assistant',
    content: parsedTools.length ? null : cleanText,
    tool_calls: parsedTools.length ? parsedTools : null,
  };
  if (reasoning) msgDict.reasoning_content = reasoning;

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msgDict, finish_reason: parsedTools.length ? 'tool_calls' : 'stop' }],
    usage: usagePayload,
  };
}

function formatAnthropicResponse(result, model) {
  const choice = result.choices[0];
  const msg = choice.message;
  const antContent = [];
  if (msg.reasoning_content) antContent.push({ type: 'thinking', thinking: msg.reasoning_content });
  if (msg.content) antContent.push({ type: 'text', text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      const toolInput = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      antContent.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: toolInput });
    }
  }
  const usage = result.usage || {};
  let msgId = result.id;
  if (!msgId.startsWith('msg_')) msgId = `msg_${msgId.replace('chatcmpl-', '')}`;
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content: antContent,
    model,
    stop_reason: msg.tool_calls ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: (usage.prompt_tokens_details || {}).cached_tokens || 0,
    },
  };
}

function convertAnthropicMessages(messages) {
  const openaiMsgs = [];
  for (const m of messages) {
    let content = m.content ?? '';
    const toolCalls = [];
    const toolResults = [];
    if (Array.isArray(content)) {
      const parts = [];
      const imageParts = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text') parts.push(c.text || '');
        else if (c.type === 'image') imageParts.push(c);
        else if (c.type === 'tool_use') {
          toolCalls.push({ id: c.id || `call_${crypto.randomBytes(4).toString('hex')}`, type: 'function', function: { name: c.name || '', arguments: JSON.stringify(c.input || {}) } });
        } else if (c.type === 'tool_result') {
          let resContent = c.content ?? '';
          if (Array.isArray(resContent)) {
            for (const item of resContent) if (item && typeof item === 'object' && item.type === 'image') imageParts.push(item);
            resContent = resContent.filter((item) => item && typeof item === 'object' && item.type === 'text').map((item) => item.text || '').join(' ');
          } else if (typeof resContent !== 'string') {
            resContent = String(resContent);
          }
          toolResults.push({ tool_call_id: c.tool_use_id || '', content: resContent });
        }
      }
      if (imageParts.length) content = [...parts.filter((s) => s).map((s) => ({ type: 'text', text: s })), ...imageParts];
      else content = parts.filter(Boolean).join('\n');
    }
    if (m.role === 'system') {
      if (content) openaiMsgs.push({ role: 'system', content });
      continue;
    }
    if (m.role === 'assistant') {
      if (typeof content === 'string' && (!content.trim() || content.trim() === '(no content)')) content = null;
      const msg = { role: 'assistant', content };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (msg.content == null && !toolCalls.length) continue;
      openaiMsgs.push(msg);
      continue;
    }
    for (const tr of toolResults) openaiMsgs.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
    const hasContent = Array.isArray(content) ? content.length > 0 : Boolean(content);
    if (hasContent || !toolResults.length) openaiMsgs.push({ role: m.role || 'user', content });
  }
  return openaiMsgs;
}

function isThinkingEnabled(body, request = null) {
  const TRUTHY = new Set(['medium', 'high', 'max', 'ultra', 'extreme', 'enabled', 'adaptive', 'on']);
  const FALSY = new Set(['low', 'none', 'off', 'disable', 'disabled', 'false']);
  const parseEffort = (val) => {
    if (val == null) return null;
    const e = String(val).trim().toLowerCase();
    if (TRUTHY.has(e)) return true;
    if (FALSY.has(e)) return false;
    return null;
  };
  let r = parseEffort(body.effort);
  if (r != null) return r;
  const outCfg = body.output_config;
  if (outCfg && typeof outCfg === 'object') {
    r = parseEffort(outCfg.effort ?? outCfg.reasoning_effort);
    if (r != null) return r;
  }
  const thinkingVal = body.thinking;
  if (thinkingVal && typeof thinkingVal === 'object') {
    const tType = String(thinkingVal.type || '').trim().toLowerCase();
    if (['enabled', 'adaptive', 'true'].includes(tType)) return true;
    if (tType === 'disabled') return false;
    const budget = thinkingVal.budget_tokens;
    if (typeof budget === 'number' && budget > 0) return true;
    r = parseEffort(thinkingVal.effort ?? thinkingVal.reasoning_effort ?? thinkingVal.level);
    if (r != null) return r;
  } else if (typeof thinkingVal === 'string') {
    const t = thinkingVal.trim().toLowerCase();
    if (['medium', 'high', 'max', 'ultra', 'extreme', 'true', 'enabled', 'adaptive', 'on'].includes(t)) return true;
    if (['low', 'none', 'off', 'disable', 'disabled', 'false'].includes(t)) return false;
  } else if (typeof thinkingVal === 'boolean') {
    return thinkingVal;
  }
  r = parseEffort(body.reasoning_effort);
  if (r != null) return r;
  if (request && request.headers) {
    const reqEffort = request.headers['anthropic-thinking'] || request.headers['x-anthropic-thinking'] || request.headers['effort'] || request.headers['x-effort'];
    if (reqEffort) {
      const e = String(reqEffort).trim().toLowerCase();
      if (TRUTHY.has(e)) return true;
    }
  }
  return false;
}

module.exports = {
  PUBLIC_MODEL, SINGLE_MODEL, resolveModel, displayModel, sanitizeAlias, setKeyNameReq,
  logUsage, splitReasoning, openaiUsagePayload, turnCompletion, messagesText, holdThinkTags,
  collectResponse, preflightStream, OwnedLock, takeLock, chatLock, ownChatLock,
  releaseChatLockStream, apiErrorResponse, handleChat,
  streamResponse, streamAnthropicResponse, formatResponse, formatAnthropicResponse,
  convertAnthropicMessages, isThinkingEnabled,
};
