const crypto = require('crypto');
const { getHeaders, postWithFailover, getWithFailover, UPSTREAM_BASE } = require('./upstream');
const { solveCreatePow } = require('./pow');

const DEFAULT_MODEL_TYPE = null;

async function createNewChat(authToken) {
  const headers = getHeaders(authToken);
  const resp = await postWithFailover('/api/v0/chat_session/create', { headers, timeoutMs: 20000 });
  const data = await resp.json();
  return data.data.biz_data.chat_session.id;
}

// Async iterable over a web stream of SSE-ish lines.
async function* lineStream(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield line;
    }
  }
  if (buffer) yield buffer;
  try { reader.releaseLock(); } catch (_) {}
}

async function* sendMessage(chatId, authToken, message, parentMessageId, thinking = false, search = false, fileIds_ = null, usageTracker = null) {
  if (parentMessageId === 0) parentMessageId = null;
  const fileIds = fileIds_ || [];

  const headers = getHeaders(authToken, await solveCreatePow('/api/v0/chat/completion', authToken));
  const jsonData = {
    chat_session_id: chatId,
    parent_message_id: parentMessageId,
    model_type: DEFAULT_MODEL_TYPE,
    prompt: message,
    ref_file_ids: fileIds,
    thinking_enabled: thinking,
    search_enabled: search,
    preempt: false,
    action: null,
  };

  let thinkOpen = false;
  let gotOutput = false;
  const resp = await postWithFailover('/api/v0/chat/completion', { headers, json: jsonData });
  if (resp.status !== 200) {
    const errorText = await resp.text();
    console.warn(`DeepSeek completion HTTP ${resp.status} for chat ${chatId}: ${errorText.slice(0, 300)}`);
    throw new Error(`HTTP ${resp.status}: ${errorText}`);
  }
  try {
    for await (const rawLine of lineStream(resp.body)) {
      const decodedLine = rawLine.trim();
      if (!decodedLine.startsWith('data: ')) continue;
      let data;
      try { data = JSON.parse(decodedLine.slice(6)); } catch (_) { continue; }
      if (data.p === 'response/status' && data.v === 'FINISHED') {
        if (thinkOpen) yield '\n</think>\n\n';
        if (!gotOutput) throw new Error('Empty response from DeepSeek (prompt may exceed the session context limit)');
        return;
      }
      if (data.o === 'BATCH' && Array.isArray(data.v)) {
        for (const op of data.v) {
          if (!op || typeof op !== 'object') continue;
          const opName = String(op.p || '');
          if (opName === 'accumulated_token_usage' || opName.endsWith('/accumulated_token_usage')) {
            const accVal = parseInt(op.v, 10);
            if (!isNaN(accVal) && usageTracker && accVal > 0) usageTracker.upstream_completion = accVal;
            continue;
          }
          if (op.p === 'quasi_status' && op.v === 'FINISHED') {
            if (thinkOpen) yield '\n</think>\n\n';
            if (!gotOutput) throw new Error('Empty response from DeepSeek (prompt may exceed the session context limit)');
            return;
          }
        }
      }
      if (data.v && typeof data.v === 'object' && !Array.isArray(data.v) && 'response' in data.v) {
        const fragments = data.v.response && data.v.response.fragments;
        if (fragments) {
          for (const fragment of fragments) {
            if (fragment.type === 'THINK') {
              if (!thinkOpen) { yield '<think>\n'; thinkOpen = true; }
              gotOutput = true;
              yield fragment.content || '';
            } else {
              if (thinkOpen) { yield '\n</think>\n\n'; thinkOpen = false; }
              gotOutput = true;
              yield fragment.content || '';
            }
          }
        }
        continue;
      }
      if (data.p === 'response/fragments' && data.o === 'APPEND') {
        const fragments = data.v;
        if (Array.isArray(fragments)) {
          for (const fragment of fragments) {
            if (fragment.type === 'RESPONSE') {
              if (thinkOpen) { yield '\n</think>\n\n'; thinkOpen = false; }
              gotOutput = true;
              yield fragment.content || '';
            } else if (fragment.type === 'THINK') {
              if (!thinkOpen) { yield '<think>\n'; thinkOpen = true; }
              gotOutput = true;
              yield fragment.content || '';
            } else {
              gotOutput = true;
              yield fragment.content || '';
            }
          }
        }
        continue;
      }
      if (typeof data.v === 'string' && data.v) {
        gotOutput = true;
        yield data.v;
      }
    }
  } finally {
    try { if (resp.body) await resp.body.cancel().catch(() => {}); } catch (_) {}
  }
  if (thinkOpen) yield '\n</think>\n\n';
  if (!gotOutput) throw new Error('Empty response from DeepSeek (prompt may exceed the session context limit)');
}

async function* uploadFile(fileBytes, fileName, fileContentType, authToken) {
  const url = 'https://chat.deepseek.com/api/v0/file/upload_file';
  const fileSize = fileBytes.length;
  const powResponse = await solveCreatePow('/api/v0/file/upload_file', authToken);
  const boundary = '----WebKitFormBoundaryTB0pXOQR2RL219Hu';
  const safeName = fileName.replace(/[^ -~]/g, '_').replace(/"/g, '_') || 'file.bin';
  const bodyParts = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n`, 'utf-8'),
    Buffer.from(`Content-Type: ${fileContentType}\r\n\r\n`, 'utf-8'),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const reconstructedBody = Buffer.concat(bodyParts);
  const headers = getHeaders(authToken, powResponse);
  headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
  headers['x-file-size'] = String(fileSize);
  const response = await postWithFailover('/api/v0/file/upload_file', { data: reconstructedBody, headers, timeoutMs: 120000 });
  let respJson;
  try {
    respJson = await response.json();
  } catch (e) {
    console.warn(`file upload unreadable response (HTTP ${response.status}, ${fileName} ${fileSize} bytes): ${e.message}`);
    yield ['error', null];
    return;
  }
  const biz = ((respJson || {}).data || {}).biz_data || {};
  const fileId = biz.id;
  if (!fileId) {
    console.warn(`file upload rejected (HTTP ${response.status}, ${fileName} ${fileSize} bytes): ${JSON.stringify(respJson).slice(0, 300)}`);
    yield ['error', null];
    return;
  }
  yield ['uploaded', fileId];
  let jsData = biz;
  let status = jsData.status;
  const pollHeaders = getHeaders(authToken);
  const deadline = Date.now() + 300000;
  try {
    while ((status === 'PENDING' || status === 'PARSING') && Date.now() < deadline) {
      yield ['uploaded', fileId];
      await new Promise((r) => setTimeout(r, 300));
      const resp = await getWithFailover(`/api/v0/file/fetch_files?file_ids=${fileId}`, { headers: pollHeaders, timeoutMs: 30000 });
      const poll = await resp.json();
      const files = (((poll || {}).data || {}).biz_data || {}).files || [];
      if (!files.length) {
        console.warn(`file poll empty for ${fileId}: ${JSON.stringify(poll).slice(0, 200)}`);
        break;
      }
      jsData = files[0];
      status = jsData.status;
    }
  } catch (e) {
    console.warn(`file poll failed for ${fileId}: ${e.message}`);
    yield ['error', fileId];
    return;
  }
  if (status === 'SUCCESS' && jsData.updated_at && jsData.file_size != null) {
    yield ['success', {
      file_id: fileId,
      openai_timestamp: Math.floor(jsData.updated_at),
      size: jsData.file_size,
      anthropic_timestamp: new Date(jsData.updated_at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }];
  } else {
    console.warn(`file ${fileId} terminal status ${JSON.stringify(status)} (not SUCCESS)`);
    yield ['error', fileId];
  }
}

async function* getFileContent(authToken, fileId) {
  const headers = getHeaders(authToken);
  const fetchFiles = async () => {
    const resp = await getWithFailover(`/api/v0/file/fetch_files?file_ids=${fileId}`, { headers, timeoutMs: 30000 });
    return (await resp.json()).data.biz_data.files[0];
  };
  let jsData = await fetchFiles();
  const fileName = jsData.file_name;
  const mimeType = (require('mime-types').lookup(fileName) || 'application/octet-stream');
  yield mimeType;
  const deadline = Date.now() + 60000;
  while ((jsData.status === 'PENDING' || jsData.status === 'PARSING') && Date.now() < deadline && !jsData.signed_path) {
    await new Promise((r) => setTimeout(r, 500));
    jsData = await fetchFiles();
  }
  if (!jsData.signed_path) return;
  const filePath = 'https://files.deepseeksvc.com/api' + jsData.signed_path + '&ty=r';
  const resp = await fetch(filePath);
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) yield Buffer.from(value);
  }
}

module.exports = { createNewChat, sendMessage, uploadFile, getFileContent };
