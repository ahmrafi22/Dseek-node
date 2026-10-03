const net = require('net');
const crypto = require('crypto');
const ipaddr = require('ipaddr.js');

function parseTrustedProxies(raw) {
  const networks = [];
  for (const part of String(raw || '').split(',')) {
    const p = part.trim();
    if (!p) continue;
    try {
      const [addr, prefixLen] = p.includes('/') ? p.split('/') : [p, null];
      const ip = ipaddr.parse(addr);
      const kind = ip.kind();
      const maxLen = kind === 'ipv6' ? 128 : 32;
      const prefix = prefixLen === null ? maxLen : parseInt(prefixLen, 10);
      if (isNaN(prefix) || prefix < 0 || prefix > maxLen) throw new Error('bad prefix');
      networks.push(ipaddr.parseCIDR(`${ip.toString()}/${prefix}`));
    } catch (e) {
      console.warn(`Ignoring invalid TRUSTED_PROXIES entry: ${p}`);
    }
  }
  return networks;
}

const TRUSTED_PROXIES = parseTrustedProxies(process.env.TRUSTED_PROXIES || '');
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function isTrusted(ip) {
  if (!ip) return false;
  try {
    const addr = ipaddr.parse(ip);
    return TRUSTED_PROXIES.some(([netIp, prefix]) => addr.match(netIp, prefix));
  } catch (_) {
    return false;
  }
}

function getRealIp(req) {
  let direct = (req.socket?.remoteAddress || '').split('%')[0];
  if (!direct) return 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (!xff || typeof xff !== 'string') return direct;
  if (!TRUSTED_PROXIES.length) return direct;
  if (!isTrusted(direct)) return direct;
  let current = direct;
  const hops = xff.split(',').map((h) => h.trim());
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrusted(current)) break;
    try {
      ipaddr.parse(hops[i]);
      current = hops[i];
    } catch (_) {
      break;
    }
  }
  return current;
}

function realIpMiddleware(req, res, next) {
  req.realIp = getRealIp(req);
  next();
}

function requestIdMiddleware(req, res, next) {
  const inbound = (req.headers['x-request-id'] || '').toString().trim();
  const requestId = REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomBytes(16).toString('hex');
  req.requestId = requestId;
  const started = process.hrtime.bigint();
  res.setHeader('X-Request-ID', requestId);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${requestId} "${req.method} ${req.path || req.url}" ${res.statusCode} ${durationMs.toFixed(1)}ms ip=${req.realIp || '-'}`);
  });
  next();
}

function bodyLimitMiddleware(limitBytes) {
  return (req, res, next) => {
    const cl = req.headers['content-length'];
    if (cl && /^\d+$/.test(cl) && parseInt(cl, 10) > limitBytes) {
      return res.status(413).json({ error: 'Request body too large' });
    }
    next();
  };
}

function installErrorHandler(app) {
  // express 5 default error handler would send HTML; force JSON 500 with request id.
  app.use((err, req, res, next) => {
    console.error(`Unhandled exception (request_id=${req.requestId || '-'} ${req.method} ${req.url} ip=${req.realIp || '-'}):`, err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: { message: 'Internal server error', type: 'internal_error', request_id: req.requestId || '-' } });
  });
}

module.exports = { parseTrustedProxies, getRealIp, realIpMiddleware, requestIdMiddleware, bodyLimitMiddleware, installErrorHandler };
