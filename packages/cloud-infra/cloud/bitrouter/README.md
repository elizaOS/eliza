# Eliza Cloud BitRouter

Railway service that runs the OSS `bitrouter` proxy for Eliza Cloud model
routing.

## Runtime shape

- `bitrouter serve` binds to `127.0.0.1:4356` inside the container. Current
  BitRouter releases always require JWT auth, so startup creates an
  `eliza-cloud` wallet in a local SQLite db and signs an internal 30-day JWT.
- `auth-proxy.mjs` is the only public listener. It binds to Railway `$PORT`,
  serves `/health`, requires `Authorization: Bearer $BITROUTER_PROXY_TOKEN`,
  replaces that auth header with the internal JWT, and forwards the request to
  local BitRouter.
- Cloud API should set:
  - `BITROUTER_BASE_URL=https://<railway-domain>`
  - `BITROUTER_API_KEY=<same value as BITROUTER_PROXY_TOKEN>`

## Railway variables

Required:

- `BITROUTER_PROXY_TOKEN` — shared bearer token accepted by the public proxy.

At least one upstream provider credential is required for routable models:

- `BITROUTER_API_KEY` — BitRouter Cloud key (`brk_...`) for cloud-managed
  routing, when BitRouter Cloud billing is enabled inside the service.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, or
  `BITROUTER_CEREBRAS_API_KEY` for direct BYOK routing. BitRouter also accepts
  `BITROUTER_<PROVIDER_ID>_API_KEY` for registry providers; use the prefixed
  name when available so the proxy does not accidentally consume a key intended
  for another process.

Optional:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — enables BitRouter observability export.

## Deploy

```bash
railway add --service bitrouter
railway variables --service bitrouter --set "BITROUTER_PROXY_TOKEN=<secret>" --skip-deploys
railway variables --service bitrouter --set "BITROUTER_API_KEY=<brk_...>" --skip-deploys
railway variables --service bitrouter --set "CEREBRAS_API_KEY=<csk_...>" --skip-deploys
railway up --service bitrouter packages/cloud-infra/cloud/bitrouter --path-as-root
railway domain --service bitrouter
```

After deploy, set Cloud API Worker secrets:

```bash
wrangler secret put BITROUTER_API_KEY --env production
wrangler secret put BITROUTER_BASE_URL --env production
wrangler secret put CEREBRAS_API_KEY --env production # direct fallback when BitRouter is unavailable
```
