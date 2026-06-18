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

## gpt-oss routing policy

`gpt-oss-120b` is intentionally routed Cerebras-first:

- `gpt-oss-120b` is the bare Cerebras-native id used by the Cloud default path.
- `openai/gpt-oss-120b` and `openai/gpt-oss-120b:nitro` are legacy gateway
  aliases kept for stored settings and older clients.
- All three aliases route to Cerebras first, then to OpenRouter with the plain
  `openai/gpt-oss-120b` id as fallback.

**Why:** the `:nitro` suffix is an OpenRouter routing convention, not a healthy
model id for this self-hosted BitRouter path. Leaving new users on
`openai/gpt-oss-120b:nitro` surfaced upstream 502s as Cloud 503s, while the
bare Cerebras model was already proven live. The fallback keeps legacy callers
working without making OpenRouter the first hop.

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
- Cerebras is configured as an explicit OpenAI-compatible provider. Use
  `cerebras:gpt-oss-120b` or `cerebras:zai-glm-4.7` to force the BYOK route.

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

Redeploy BitRouter whenever `bitrouter.yaml` changes. Worker deploys alone do
not update the Railway service catalog or fallback chain.

After deploy, set Cloud API Worker secrets:

```bash
wrangler secret put BITROUTER_API_KEY --env production
wrangler secret put BITROUTER_BASE_URL --env production
wrangler secret put CEREBRAS_API_KEY --env production # direct fallback when BitRouter is unavailable
```
