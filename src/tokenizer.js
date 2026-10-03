const path = require('path');
const { Tokenizer } = require('tokenizers');

let tokenizer = null;
let initPromise = null;

async function initTokenizer() {
  if (tokenizer) return tokenizer;
  if (!initPromise) {
    initPromise = Tokenizer.fromFile(path.join(__dirname, '..', 'tokenizer.json'));
  }
  tokenizer = await initPromise;
  return tokenizer;
}

async function countTokens(text) {
  const t = await initTokenizer();
  const enc = await t.encode(String(text ?? ''));
  return enc.getLength();
}

module.exports = { initTokenizer, countTokens };
