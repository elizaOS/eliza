# Eliza Cloud hosting topology — canonical service map

Where every Eliza Cloud surface runs, how it deploys, and which request path
it serves. This file is the canonical map; the summaries in
[`../README.md`](../README.md), [`terraform/README.md`](./terraform/README.md),
and the package `CLAUDE.md`/`AGENTS.md` defer to it.

Every claim here is cross-checked against the in-repo sources of truth:
[`packages/cloud/api/wrangler.toml`](../../api/wrangler.toml) (Worker routes,
bindings, env), the Railway manifests at
`packages/cloud/services/*/railway.toml`, the Terraform roots under
[`terraform/`](./terraform/README.md), and the deploy workflows in
`.github/workflows/`. When this file and one of those configs disagree, the
config wins — fix this file.

## Service map (current)

| Surface | Runtime | Source path | Deploy mechanism | Public/private role |
|---|---|---|---|---|
| `eliza-cloud` Pages project (cloud console: lander + dashboard) | Cloudflare Pages | `packages/app/` (`build:web`) | `.github/workflows/cloud-cf-deploy.yml` `deploy-console` job | Public: `elizacloud.ai` apex (staging: `staging.elizacloud.ai`) |
| `eliza-app` Pages project (Eliza agent app: chat + views) | Cloudflare Pages | `packages/app/` (`build:web`) | same workflow, `deploy-app` job | Public: `app.elizacloud.ai` (staging: `app-staging.elizacloud.ai`) |
| `eliza-cloud-api` — REST API, auth, billing, **model gateway**, dedicated-agent proxy, batch voice routes, cron | Cloudflare Worker (`eliza-cloud-api-prod` / `eliza-cloud-api-staging`) | `packages/cloud/api/` | [`wrangler.toml`](../../api/wrangler.toml) via `cloud-cf-deploy.yml` `deploy-api` job (schema-gated on `migrate-db`) | Public: `api.elizacloud.ai/*`, `x402.elizacloud.ai/*`, and the `*.elizacloud.ai/*` wildcard (staging Worker: `staging.elizacloud.ai/*`, `app-staging.…`, `api-staging.…`, `*.staging.…`, `blob-staging.…`) |
| PostgreSQL | **Railway managed Postgres** (one instance per environment) | n/a (managed service) | env-scoped `DATABASE_URL` secret in the `staging`/`production` GitHub Environments; the Worker reaches it through the `HYPERDRIVE` binding (`wrangler.toml` `[[env.*.hyperdrive]]`) | Private |
| Redis | **Railway managed Redis** (TCP, `REDIS_URL`) | n/a (managed service) | `REDIS_URL` Worker secret; in-Worker SocketRedis speaks RESP2 over `cloudflare:sockets` (`wrangler.toml` cache/queue notes). Upstash REST (`KV_REST_API_*`) is a **legacy fallback only** | Private |
| Database migrations | GitHub Actions → Railway Postgres | `packages/cloud/shared/src/db/migrations/` | `cloud-cf-deploy.yml` `migrate-db` job (`bun run db:cloud:migrate`); every deploy job `needs: migrate-db`. Standalone/manual path: `cloud-deploy-backend.yml` (`workflow_dispatch` only) | n/a |
| `gateway-discord` (multi-tenant Discord WS gateway) | Railway (Docker) | `packages/cloud/services/gateway-discord/` | `railway.toml` + `Dockerfile`; Railway auto-deploys on push — `cloud-gateway-discord.yml` runs tests only | Discord-facing; `/internal/*` shared-secret routes |
| `gateway-webhook` (Telegram / Blooio / Twilio / WhatsApp) | Railway (Docker) | `packages/cloud/services/gateway-webhook/` | `railway.toml` + `Dockerfile`; `cloud-gateway-webhook.yml` runs tests only | Public webhook ingress |
| `voice-kokoro-tts` (free-cloud TTS) | Railway (Docker) | `packages/cloud/services/voice-kokoro-tts/` | `railway.toml`; its URL is injected at Worker deploy time as `KOKORO_TTS_URL` (GitHub var `ELIZA_VOICE_KOKORO_TTS_URL` in `cloud-cf-deploy.yml`) | **Private origin** behind the Worker's `POST /api/v1/voice/tts` — unauthenticated at the service boundary, so its URL must not be published |
| `voice-whisper-stt` (free-cloud STT) | Railway (Docker) | `packages/cloud/services/voice-whisper-stt/` | `railway.toml`; consumed via the `WHISPER_STT_URL` env var | **Private origin** behind the Worker's `POST /api/v1/voice/stt` (same posture as Kokoro) |
| `tunnel-proxy` (public HTTPS → tailnet bridge, customer-tunnel path) | Railway (Docker, Go) | `packages/cloud/services/tunnel-proxy/` | `railway.toml` + `Dockerfile` | Public: `tunnel.elizacloud.ai` + `*.tunnel.elizacloud.ai` |
| `feed` | Railway | `packages/feed/` | `packages/feed/railway.json`; the prod Worker reverse-proxies `feed.elizacloud.ai` to it via `FEED_ORIGIN_HOST` (`wrangler.toml` `[env.production]`) | Public via the Worker wildcard carve-out; see `packages/feed/RAILWAY.md` |
| `headscale` (Tailscale coordination server: agents + customer tunnels) | Hetzner control-plane VM (systemd) | `packages/cloud/services/headscale/` | armed by `arm-headscale-control-plane.yml` (ACL [`acl.hujson`](../../services/headscale/acl.hujson)); its DNS record is Terraform-managed ([`terraform/hetzner/control-plane/`](./terraform/hetzner/control-plane/README.md)) | Public: `headscale[-staging].elizacloud.ai`, served by nginx + Let's Encrypt on the CP VM (DNS-only record, not CF-proxied) |
| `eliza-provisioning-worker` (job-queue consumer) + `eliza-agent-router` (subdomain HTTP routing) | Hetzner control-plane VM (systemd) | `packages/scripts/cloud/admin/daemons/` | `deploy-eliza-provisioning-worker.yml` (SSH deploy on push to `develop`/`main`) | Control-plane internals; agent-router is the nginx-fronted origin the Worker proxies agent subdomains to |
| `agent-server` (per-customer dedicated agent runtime) | Docker containers on Hetzner **data-plane** nodes | `packages/cloud/services/agent-server/` | provisioned by the provisioning worker off the jobs queue; dedicated nodes live in the `docker_nodes` table, burst capacity is minted by `node-autoscaler.ts` | Reached only through the Worker's dedicated-agent proxy (request path below) |
| `container-control-plane` (Node sidecar for container mutations) | Node/Bun sidecar reached via `CONTAINER_CONTROL_PLANE_URL` | `packages/cloud/services/container-control-plane/` | env-driven | Private Worker→sidecar; its remaining cron paths are being folded into the daemon-queue pattern ([`terraform/hetzner/ARCHITECTURE.md`](./terraform/hetzner/ARCHITECTURE.md) followups) |
| `vast-pyworker` (eliza-1 GGUF GPU serving for `vast/*` models) | Vast.ai Serverless | `packages/cloud/services/vast-pyworker/` | Vast template (image + on-start script committed in that package); the Worker calls it via the `VAST_API_KEY`/`VAST_BASE_URL` secrets | Private model origin |

The `operator` service (Pepr Kubernetes operator) and the kind cluster under
[`local/`](./local/) are **local development only** — nothing in production
runs on Kubernetes.

Steward (the auth provider) runs **embedded in the Worker**: `bootstrap-app.ts`
mounts the embedded handler at `/steward*`
(`packages/cloud/api/src/steward/embedded.ts`); the `STEWARD_*` secrets in
`wrangler.toml` configure it. Its data lives as an embedded `steward` schema in
the shared Railway Postgres DB (migration
`packages/cloud/shared/src/db/migrations/0096_steward_embedded_schema.sql`), not
a separate database. There is no separate Steward deployment in this repo.

## Request paths

Four user-facing paths share the one Worker; keep them distinct when editing
routes or docs.

### Chat (shared runtime)

Browser/app (Pages bundle built from `packages/app`) → `api.elizacloud.ai`
(Worker) → auth + billing → **the Worker itself is the model gateway**: it
calls native providers directly (Cerebras/OpenAI/Anthropic/Groq/Vast) and uses
OpenRouter (BYOK, `OPENROUTER_API_KEY`) as the backup for models with no
native key (see the retired-BitRouter note below). State: Railway Postgres via
Hyperdrive, Railway Redis, KV cache, R2 blobs.

### Dedicated agents

`https://<agentId>.elizacloud.ai/*` falls into the Worker's
`*.elizacloud.ai/*` wildcard route →
`packages/cloud/api/src/dedicated-agent-proxy.ts` validates the cloud token
(swapping in the per-container `ELIZA_API_TOKEN` only for a validated owner) →
proxies to `AGENT_ROUTER_ORIGIN_HOST` (`eliza-production-1.elizacloud.ai` /
`eliza-staging-1.elizacloud.ai`, set in `wrangler.toml`) → **nginx on the
control-plane VM** (self-signed wildcard cert; the CF zone stays on SSL mode
"Full") → `eliza-agent-router` → headscale tailnet → the agent's container on
a data-plane node. `cloudflared` is **not** part of this request path — the
control-plane ingress is nginx (cloud-init installs it;
`arm-headscale-control-plane.yml` converges the headscale vhost + Let's
Encrypt cert).

### Batch voice (deployed)

- `POST /api/v1/voice/tts` (`packages/cloud/api/v1/voice/tts/route.ts`) —
  Kokoro is the free default when `KOKORO_TTS_URL` is configured; ElevenLabs
  serves custom voice ids (provider gate:
  `v1/voice/tts/provider-selection.ts`), and Cartesia is a synthesis-engine
  substitution inside the ElevenLabs branch (`v1/voice/tts/route.ts`).
- `POST /api/v1/voice/stt` (`packages/cloud/api/v1/voice/stt/route.ts`) —
  Railway Whisper via `WHISPER_STT_URL` (OpenAI-compatible
  `/v1/audio/transcriptions`).

The Worker owns auth and billing; the Railway voice services are
unauthenticated **private** origins.

### Realtime voice (merged, NOT live)

Session mint/consent/revoke/WS routes exist under
`packages/cloud/api/v1/voice/session/` with Deepgram (STT) and Cartesia (TTS)
adapters — but every entrypoint gates on `VOICE_REALTIME_WS_ENABLED`
(`packages/cloud/shared/src/lib/voice-session/config.ts`): when the flag is
unset the mint route returns 404, the WS refuses the upgrade, and clients fall
back to the batch path. No committed environment sets any `VOICE_REALTIME_*`
var (`wrangler.toml` has none), so **do not document realtime voice as a
deployed public API** until an operator explicitly enables the flag.

## headscale (not Railway — Hetzner control-plane VM)

`headscale` is the Tailscale coordination server for both internal agents
(`tag:agent`) and customer tunnels (`tag:eliza-tunnel`). It runs **on the
Hetzner control-plane VM** — the provisioning worker and agent router talk to
it over a private loopback API. The previous Railway-hosted headscale runtime
was decommissioned on 2026-06-17.

- Runtime: Hetzner control-plane VM (nginx + Let's Encrypt terminate TLS in
  front of local headscale).
- Public domain: `headscale.elizacloud.ai` → CP VM (DNS-only record managed by
  the control-plane Terraform root).
- ACL source of truth: [`packages/cloud/services/headscale/acl.hujson`](../../services/headscale/acl.hujson),
  deployed by `arm-headscale-control-plane.yml`.
- Provisioning runbook: [`packages/cloud/services/headscale/DEPLOY.md`](../../services/headscale/DEPLOY.md).

## Railway services in detail

### `tunnel-proxy`

- Builder: Dockerfile (Go binary).
- Healthcheck: `GET /health` (served by [`main.go`](../../services/tunnel-proxy/main.go)).
- Volume: `/var/lib/tunnel-proxy` (tsnet node identity).
- Public domain: `tunnel.elizacloud.ai` + wildcard `*.tunnel.elizacloud.ai`.
- Provisioning runbook: [`packages/cloud/services/headscale/DEPLOY.md`](../../services/headscale/DEPLOY.md) (covers both services).

### `gateway-discord` / `gateway-webhook`

Docker/Bun services with `railway.toml` manifests; Railway auto-deploys on
push to the watched branch. Their GitHub workflows
(`cloud-gateway-discord.yml`, `cloud-gateway-webhook.yml`) run tests only —
the AWS EKS/Terraform/Helm deploy jobs were removed with the AWS retirement
([`AWS_RETIREMENT.md`](./AWS_RETIREMENT.md)). Required env vars are documented
in each service's `railway.toml` header.

### `voice-kokoro-tts` / `voice-whisper-stt`

Free-cloud voice origins behind the Worker's public `/api/v1/voice/*` routes.
Both are unauthenticated at the service boundary (the Worker owns auth and
billing upstream), so their Railway URLs are configuration, not public API.
Generous `healthcheckTimeout` (300s) because cold deploys load model weights
before `/health` goes green.

## Placement rules for new services

- Long-running stateful HTTP service → **Railway**: add a `railway.toml` next
  to its `Dockerfile`, point the healthcheck at a real endpoint, and add a row
  to the service map above.
- Per-customer compute or GPU-bound workload → **Hetzner** via the
  provisioning worker / data-plane pattern.
- Stateless, low-latency, JWT-gated REST → **Cloudflare Worker** (extend
  `packages/cloud/api`).
- Do not add AWS dependencies ([`AWS_RETIREMENT.md`](./AWS_RETIREMENT.md)).

## Retired (historical — do not target)

- **BitRouter (Railway model router)** — removed. The Worker is the model
  gateway now; see
  [`bitrouter/CLOUDFLARE_MIGRATION_PLAN.md`](./bitrouter/CLOUDFLARE_MIGRATION_PLAN.md)
  for the record.
- **Neon Postgres** — the shared cloud DB moved to Railway Postgres.
  `wrangler.toml` marks `NEON_API_KEY` as retired; the migration workflows
  keep `NEON_DATABASE_URL` only as the last fallback name for the env-scoped
  secret.
- **Upstash Redis as primary** — Railway TCP Redis (`REDIS_URL`) is primary;
  the Upstash REST path (`KV_REST_API_*`) survives only as a legacy fallback
  in the Worker cache client.
- **`packages/cloud-frontend`** — deleted. Both Pages projects build
  `packages/app` (see the `cloud-cf-deploy.yml` header).
- **AWS EKS gateway deployments** — deleted (terraform + Helm chart + CI
  jobs); gateways run on Railway.
- **Railway-hosted headscale** — decommissioned 2026-06-17 (now on the CP VM).
- **`cloudflared` control-plane ingress** — not in the request path; nginx
  (+ Let's Encrypt for the headscale vhost) is the CP ingress. Older VMs may
  still carry `/root/.cloudflared/` state; nothing in the repo provisions or
  requires it.
- **Legacy fullstack `railway.toml`** (old Next.js `cloud` app) — file removed;
  nothing references it.
- **Legacy agent VPS deploy** — still exists behind the `deploy_legacy_vps`
  `workflow_dispatch` input on `cloud-deploy-backend.yml`, **off by default**;
  new code should not target it.
