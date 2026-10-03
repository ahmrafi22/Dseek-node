# Dseek-Node (DeeperSeeker, Node.js build)

Unofficial DeepSeek web reverse-proxy, ported to a self-contained Node.js (Express) project. Exposes OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/files`) and Anthropic-compatible (`/v1/messages`, `/v1/files/upload`) APIs, plus a dashboard with token usage, cost accounting, and optional Neon Postgres cloud sync.

> Warning: automated use violates DeepSeek's Terms of Use. Use a dedicated throwaway account at your own risk.

## Quickstart

```bash
npm install
cp .env.example .env   # fill in DEEPSEEKER_API_KEY, admin credentials, NEON_DATABASE_URL
npm start              # serves on http://127.0.0.1:4000
```

Dashboard: `http://127.0.0.1:4000/` (default admin/admin — change in `.env`).

## Features

- Token pooling with random rotation and auto rate-limit recovery
- Session/context reuse per conversation signature, with summarize-and-rollover at ~393K tokens
- Streaming SSE with think-block reassembly and multi-format tool-call parsing
- PoW challenge solving via bundled `wasm/deepseek_pow_solver.wasm` (plain WebAssembly, no runtime deps)
- Token accounting + cost estimate, stored in `deeperseeker.db` (SQLite, WAL)
- Neon Postgres cloud sync: usage + tokens queue and flush every 250 ms in the background (never blocks DeepSeek calls); dashboard can upload all local data and view current Neon rows
- Fail-closed `X-Forwarded-For` (TRUSTED_PROXIES), per-request IDs, JSON 500 barrier

## API

- `POST /v1/chat/completions` — OpenAI (stream + `stream_options.include_usage`)
- `POST /v1/responses` — OpenAI Responses API
- `POST /v1/messages` (or `/messages`) — Anthropic Messages
- `GET /v1/models`, `GET /v1/usage?days=N`
- `POST /v1/files`, `POST /v1/files/upload`, `GET /v1/files/{id}`, `GET /v1/files/{id}/content`
- `GET /health`

Auth: `Authorization: Bearer <DEEPSEEKER_API_KEY>` (default `dseeker`).

## Docker

```bash
cp .env.example .env
docker build -t dseek-node .
docker run -d -p 4000:4000 --env-file .env -v dseek_data:/app/data dseek-node
```

`DB_PATH=/app/data/deeperseeker.db` and `DEEPSEEKER_COOKIE_PATH` are wired to persist in the volume.

## Config

See `.env.example` — every knob is documented there (context policy, cache-rate accounting, trusted proxies, upstream failover, Neon URL).

## Notes

- Backend model id is `v4.1flash`; the public id `deepseek-v4.1-flash` (plus legacy aliases) is accepted and echoed back.
- Tool calling, streaming, vision and file upload are handled natively by the upstream model (`ref_file_ids`), no Playwright/WAF cookie harvesting required.
- Session signatures computed with the Node build differ from the old Python DB rows, so old sessions re-create once; no data is lost.

## License

MIT (see LICENSE). This project is not affiliated with DeepSeek.
