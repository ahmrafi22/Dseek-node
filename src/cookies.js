const fs = require('fs');
const path = require('path');
const config = require('./config');

function cookieFilePath() {
  const p = process.env.DEEPSEEKER_COOKIE_PATH;
  if (p) return p;
  let target = 'aws_cookies_deepseek.json';
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      const real = fs.realpathSync(target);
      if (real) target = real;
    }
  } catch (_) {}
  const dir = path.dirname(path.resolve(config.dbPath));
  if (dir && path.resolve(dir) !== path.resolve(process.cwd())) {
    return path.join(dir, 'aws_cookies_deepseek.json');
  }
  return target;
}

function readValidCookies() {
  try {
    const c = JSON.parse(fs.readFileSync(cookieFilePath(), 'utf8'));
    if (c.expiry != null && c.expiry > Date.now() / 1000) return c.cookie;
  } catch (_) {}
  return null;
}

function cookiesValidNow() {
  try {
    const c = JSON.parse(fs.readFileSync(cookieFilePath(), 'utf8'));
    return Boolean(c.expiry && c.expiry > Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

module.exports = { cookieFilePath, readValidCookies, cookiesValidNow };
