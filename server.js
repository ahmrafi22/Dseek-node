const config = require('./src/config');
const { initDb } = require('./src/db');
const { initTokenizer } = require('./src/tokenizer');
const { createApp } = require('./src/routes');

async function main() {
  initDb();
  await initTokenizer();
  try {
    await require('./src/neon').initNeon();
  } catch (e) {
    console.error('Neon init failed (non-fatal):', e.message);
  }
  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`DeeperSeeker listening on http://${config.host}:${config.port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
