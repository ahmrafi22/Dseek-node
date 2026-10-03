const UPSTREAM_BASE = (process.env.DEEPSEEKER_UPSTREAM_BASE || 'https://chat.deepseek.com').replace(/\/+$/, '');
const UPSTREAM_FALLBACK = (process.env.DEEPSEEKER_UPSTREAM_FALLBACK || '').replace(/\/+$/, '');
const UPSTREAM_BASES = UPSTREAM_FALLBACK ? [UPSTREAM_BASE, UPSTREAM_FALLBACK] : [UPSTREAM_BASE];

let tzOffset = '19800';
try {
  tzOffset = String(-new Date().getTimezoneOffset() * 60);
} catch (_) {}

function getHeaders(authToken, pow = null) {
  const headers = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: 'https://chat.deepseek.com',
    referer: 'https://chat.deepseek.com/',
    'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 14; Pixel 7)',
    'x-client-platform': 'android',
    'x-client-version': '2.4.5',
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-timezone-offset': tzOffset,
  };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;
  if (pow) headers['x-ds-pow-response'] = pow;
  return headers;
}

async function postWithFailover(path, { headers, json, data, timeoutMs, ...rest } = {}) {
  let lastExc = null;
  for (let attempt = 0; attempt < UPSTREAM_BASES.length; attempt++) {
    const base = UPSTREAM_BASES[attempt];
    const isLast = attempt === UPSTREAM_BASES.length - 1;
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const init = { method: 'POST', headers: { ...headers }, signal: controller.signal, ...rest };
      if (json !== undefined) {
        init.body = JSON.stringify(json);
      } else if (data !== undefined) {
        init.body = data;
      }
      const resp = await fetch(base + path, init);
      if (timer) clearTimeout(timer);
      if (resp.status >= 500 && !isLast) {
        let body = '';
        try { body = await resp.text(); } catch (_) {}
        try { await resp.body?.cancel(); } catch (_) {}
        console.warn(`Upstream POST ${path} -> HTTP ${resp.status} on ${base}; failing over`);
        lastExc = new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
        continue;
      }
      if (attempt > 0) console.log(`Upstream POST ${path} succeeded on fallback endpoint ${base}`);
      return resp;
    } catch (e) {
      if (timer) clearTimeout(timer);
      console.warn(`Upstream POST ${path} failed on ${base}: ${e.message || e}`);
      lastExc = e;
      if (isLast) throw e;
    }
  }
  throw lastExc || new Error('postWithFailover: no endpoints configured');
}

async function getWithFailover(pathOrUrl, { headers, timeoutMs } = {}) {
  // For simple GETs the Python code used the shared session directly against
  // the primary host; keep behavior but honor the same timeout shape.
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : UPSTREAM_BASE + pathOrUrl;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    return resp;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { postWithFailover, getWithFailover, getHeaders, UPSTREAM_BASES, UPSTREAM_BASE };
