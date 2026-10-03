const fs = require('fs');
const path = require('path');
const { postWithFailover, getHeaders } = require('./upstream');

let powSetup = null;
let powSetupPromise = null;

async function getPowSetup() {
  if (powSetup) return powSetup;
  if (!powSetupPromise) {
    powSetupPromise = (async () => {
      const bytes = fs.readFileSync(path.join(__dirname, '..', 'wasm', 'deepseek_pow_solver.wasm'));
      const module = await WebAssembly.compile(bytes);
      const instance = await WebAssembly.instantiate(module, {});
      powSetup = instance.exports;
      return powSetup;
    })();
  }
  return powSetupPromise;
}

function writeStringPow(text, allocFunc, memory, instance) {
  const data = Buffer.from(text, 'utf-8');
  const ptr = allocFunc(data.length);
  const mem = new Uint8Array(instance.exports.memory.buffer);
  data.copy(mem, ptr);
  return [ptr, data.length];
}

function findPowAnswerBlocking(challengeData, exports) {
  const memory = exports.memory;
  const allocFunc = exports.alloc;
  const solveFunc = exports.solve_pow;
  const [chPtr, chLen] = writeStringPow(challengeData.challenge, allocFunc, memory, { exports });
  const [saltPtr, saltLen] = writeStringPow(challengeData.salt, allocFunc, memory, { exports });
  let result = solveFunc(chPtr, chLen, saltPtr, saltLen, BigInt(challengeData.expire_at), BigInt(challengeData.difficulty));
  if (typeof result === 'bigint') {
    if (result < 0n) result = result + (1n << 64n);
    return result === 0xFFFFFFFFFFFFFFFFn ? null : Number(result);
  }
  return result === 0xFFFFFFFFFFFFFFFF || result === -1 ? null : result;
}

async function createChallangePow(targetPath, authToken) {
  const headers = getHeaders(authToken);
  const resp = await postWithFailover('/api/v0/chat/create_pow_challenge', {
    headers,
    json: { target_path: targetPath },
    timeoutMs: 20000,
  });
  const data = await resp.json();
  return data.data.biz_data.challenge;
}

async function findPowAnswer(challengeData) {
  const exports = await getPowSetup();
  return findPowAnswerBlocking(challengeData, exports);
}

async function solveCreatePow(targetPath, authToken) {
  const pow = await createChallangePow(targetPath, authToken);
  const answer = await findPowAnswer(pow);
  if (answer === null || answer === undefined) throw new Error('PoW solve failed');
  const jsonData = {
    algorithm: 'DeepSeekHashV1',
    challenge: pow.challenge,
    salt: pow.salt,
    answer,
    signature: pow.signature,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(jsonData), 'utf-8').toString('base64');
}

module.exports = { solveCreatePow, createChallangePow, findPowAnswer };
