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
| `eliza-app` Pages project (homepage, auth, cloud management, and managed agent app) | Cloudflare Pages | `packages/app/` (`build:web`, embedding `packages/homepage`) | `.github/workflows/cloud-cf-deploy.yml` `deploy-app` job | Public: `eliza.app` + `cloud.eliza.app` (staging: `staging.eliza.app` + `cloud-staging.eliza.app`) |
| `eliza-cloud-api` — REST API, auth, billing, **model gateway**, dedicated-agent proxy, batch voice routes, cron | Cloudflare Worker (`eliza-cloud-api-prod` / `eliza-cloud-api-staging`) | `packages/cloud/api/` | [`wrangler.toml`](../../api/wrangler.toml) via `cloud-cf-deploy.yml` `deploy-api` job (schema-gated on `migrate-db`) | Public: `api.eliza.app`, `x402.eliza.app`, and `*.cloud.eliza.app` (staging uses `*-staging.eliza.app`); legacy elizacloud.ai routes issue 308 redirects |
| PostgreSQL | **Railway managed Postgres** (one instance per environment) | n/a (managed service) | env-scoped `DATABASE_URL` secret in the `staging`/`production` GitHub Environments; the Worker reaches it through the `HYPERDRIVE` binding (`wrangler.toml` `[[env.*.hyperdrive]]`) | Private |
| Redis | **Railway managed Redis** (TCP, `REDIS_URL`) | n/a (managed service) | `REDIS_URL` Worker secret; in-Worker SocketRedis speaks RESP2 over `cloudflare:sockets` (`wrangler.toml` cache/queue notes). Upstash REST (`KV_REST_API_*`) is a **legacy fallback only** | Private |
| Database migrations | GitHub Actions → Railway Postgres | `packages/cloud/shared/src/db/migrations/` | `cloud-cf-deploy.yml` `migrate-db` job (`bun run db:cloud:migrate`); every deploy job `needs: migrate-db` | n/a |
| `gateway-discord` (multi-tenant Discord WS gateway) | Railway (Docker) | `packages/cloud/services/gateway-discord/` | `railway.toml` + `Dockerfile`; Railway auto-deploys on push — `cloud-gateway-discord.yml` runs tests only | Discord-facing; `/internal/*` shared-secret routes |
| `gateway-webhook` (Telegram / Blooio / Twilio / WhatsApp) | Railway (Docker) | `packages/cloud/services/gateway-webhook/` | protected `.github/workflows/deploy-gateway-webhook.yml` using `railway.toml` + `Dockerfile` | Public webhook ingress |
| `voice-kokoro-tts` (free-cloud TTS) | Railway (Docker) | `packages/cloud/services/voice-kokoro-tts/` | `railway.toml`; its URL is injected at Worker deploy time as `KOKORO_TTS_URL` (GitHub var `ELIZA_VOICE_KOKORO_TTS_URL` in `cloud-cf-deploy.yml`) | **Private origin** behind the Worker's `POST /api/v1/voice/tts` — unauthenticated at the service boundary, so its URL must not be published |
| `voice-whisper-stt` (free-cloud STT) | Railway (Docker) | `packages/cloud/services/voice-whisper-stt/` | `railway.toml`; consumed via the `WHISPER_STT_URL` env var | **Private origin** behind the Worker's `POST /api/v1/voice/stt` (same posture as Kokoro) |
| `tunnel-proxy` (public HTTPS → tailnet bridge, customer-tunnel path) | Railway (Docker, Go) | `packages/cloud/services/tunnel-proxy/` | protected `.github/workflows/deploy-tunnel-proxy.yml` using `railway.toml` + `Dockerfile` | Public: `tunnel.eliza.app` (staging: `tunnel-staging.eliza.app`) |
| `headscale` (Tailscale coordination server: agents + customer tunnels) | Hetzner control-plane VM (systemd) | `packages/cloud/services/headscale/` | armed by `arm-headscale-control-plane.yml` (ACL [`acl.hujson`](../../services/headscale/acl.hujson)); its DNS record is Terraform-managed ([`terraform/hetzner/control-plane/`](./terraform/hetzner/control-plane/README.md)) | Public: `headscale.eliza.app` / `headscale-staging.eliza.app`, served by nginx + Let's Encrypt on the CP VM |
| `eliza-provisioning-worker` (job-queue consumer) + `eliza-agent-router` (subdomain HTTP routing) | Hetzner control-plane VM (systemd) | `packages/cloud/scripts/admin/daemons/` | `deploy-eliza-provisioning-worker.yml` (SSH deploy on push to `develop`/`main`) | Control-plane internals; agent-router is the nginx-fronted origin the Worker proxies agent subdomains to |
| `agent-server` (per-customer dedicated agent runtime) | Docker containers on Hetzner **data-plane** nodes | `packages/cloud/services/agent-server/` | provisioned by the provisioning worker off the jobs queue; dedicated nodes live in the `docker_nodes` table, burst capacity is minted by `node-autoscaler.ts` | Reached only through the Worker's dedicated-agent proxy (request path below) |
| `container-control-plane` (Node sidecar for container mutations) | Node/Bun sidecar reached via `CONTAINER_CONTROL_PLANE_URL` | `packages/cloud/services/container-control-plane/` | env-driven | Private Worker→sidecar; its remaining cron paths are being folded into the daemon-queue pattern ([`terraform/hetzner/ARCHITECTURE.md`](./terraform/hetzner/ARCHITECTURE.md) followups) |
| `vast-pyworker` (eliza-1 GGUF GPU serving for `vast/*` models) | Vast.ai Serverless | `packages/cloud/services/vast-pyworker/` | Vast template (image + on-start script committed in that package); the Worker calls it via the `VAST_API_KEY`/`VAST_BASE_URL` secrets | Private model origin |

The `operator` service (Pepr Kubernetes operator) and the kind cluster under
[`local/`](./local/) are **local development only** — nothing in production
runs on Kubernetes.

### Database identity activation boundary

The migration runner evaluates a read-only PostgreSQL identity gate on the
exact session that performs migrations, after acquiring its database-wide
advisory lock and before its first schema DDL. This session binding prevents a
separate preflight connection from approving one resolved database while a
later connection mutates another. The gate hashes the physical PostgreSQL
system identifier and the environment/cluster/role/database tuple; raw
connection strings, hosts, roles, and database names are never written to
logs. Protected environment variables control activation:

- `DATABASE_IDENTITY_GATE_MODE=off` is the default, performs no query, and
  does not parse any prepared expected receipts.
- `report` emits nonsecret SHA-256 cluster and authority receipts without
  blocking a release. Malformed prepared receipts are ignored as unreviewed,
  and connection or query failures produce only a sanitized warning. Operators
  use this mode only to prepare and review a cutover.
- `enforce` requires both `DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256` and
  `DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256` and fails before migrations on
  any mismatch.

The standalone `preflight-database-identity.ts` command remains a read-only
receipt preparation tool; it is not the release enforcement boundary. Before
activation, prove that the protected migration role can execute
`pg_catalog.pg_control_system()` through `pg_monitor` membership or a narrower
explicit function grant.

Every protected workflow that invokes the remote migrator forwards this same
environment-scoped gate configuration: the canonical Cloudflare release, the
manual legacy migration, and the exact-SHA provisioning-worker predeploy. None
uses the standalone receipt tool as mutation admission.

This gate proves only the GitHub migration authority. Do not enable `enforce`
until an operator has provisioned an independent staging Railway PostgreSQL
service, role, volume, backup/PITR policy, and restore drill, and has separately
proved that the staging Hyperdrive origin produces the same reviewed identity.
The repository cannot infer Railway service/volume or backup state from a
PostgreSQL connection, and `report` mode is not evidence that those protected
resources exist.

### PostgreSQL recovery and staging-isolation gate

The `migrate-db` job in `cloud-cf-release.yml` owns a read-only Railway
resilience preflight before schema mutation. It is inert by default:

- `DATABASE_RESILIENCE_GATE_MODE=off` performs no Railway query.
- `report` queries only project/service, immutable volume-instance, PITR,
  schedule, and backup metadata; unmet checks are recorded without blocking
  migrations.
- `enforce` fails before migrations unless the selected Postgres 18 service has
  exactly one ready data volume, PITR storage is wired, daily and weekly backup
  schedules exist, and a scheduled backup is within
  `DATABASE_RESILIENCE_MAX_BACKUP_AGE_HOURS` (36 by default).
- Staging enforcement also requires protected SHA-256 receipts for the
  production Postgres service and immutable volume-instance ID and proves the
  selected staging service and volume differ. Mutable volume labels are never
  isolation evidence. A volume receipt is emitted only after that instance is
  bound to the selected project, environment, service, and Postgres data mount.
  The gate emits receipts and booleans only; it does
  not print connection strings, Railway inventory, raw service IDs, or volume
  names.

The protected environment supplies `RAILWAY_PROJECT_ID`,
`RAILWAY_ENVIRONMENT_ID`, `RAILWAY_POSTGRES_SERVICE_ID`, and `RAILWAY_TOKEN`.
Staging additionally supplies `RAILWAY_PRODUCTION_POSTGRES_SERVICE_RECEIPT`
and `RAILWAY_PRODUCTION_POSTGRES_VOLUME_RECEIPT`. Generate those receipts from
a successful production `report` run; never copy a production credential into
staging.

Activation order is fail-closed:

1. Enable PITR plus daily and weekly schedules on the existing production
   service through a separately reviewed protected operator change. Capture a
   successful scheduled backup and restore drill before enforcement.
2. Run production in `report`, retain its nonsecret service/volume receipts,
   then set production to `enforce` only after the restore evidence is reviewed.
3. Provision a separate staging Postgres 18 service, role, and volume. Enable
   and prove the same recovery policy before copying staging data.
4. Record the production receipts in the protected staging variables, run
   staging in `report`, and require every physical-isolation and recovery check
   to pass before the bounded write quiesce and final sync.
5. Set staging to `enforce` before changing either the protected migration
   authority or Hyperdrive origin. Keep both authorities together throughout
   cutover and rollback; the separate database-identity gate verifies their
   logical/cluster authority before migrations.
6. Do not remove the old staging database until the new target passes schema,
   count/digest, authenticated API, Shared-agent, provisioning, backup restore,
   and rollback proof. After post-cutover writes, reconcile forward before any
   repoint instead of blindly switching back.

This gate does not provision, enable PITR, restore, copy, repoint, or delete
resources. Those mutations remain explicit protected operations with their own
review and rollback evidence.

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

Browser/app (Pages bundle built from `packages/app`) → `api.eliza.app`
(Worker) → auth + billing → **the Worker itself is the model gateway**: it
calls native providers directly (Cerebras/OpenAI/Anthropic/Groq/Vast) and uses
OpenRouter (BYOK, `OPENROUTER_API_KEY`) as the backup for models with no
native key (see the retired-BitRouter note below). State: Railway Postgres via
Hyperdrive, Railway Redis, KV cache, R2 blobs.

### Dedicated agents

`https://<agentId>.cloud.eliza.app/*` falls into the Worker's
`*.cloud.eliza.app/*` wildcard route →
`packages/cloud/api/src/dedicated-agent-proxy.ts` validates the cloud token
(swapping in the per-container `ELIZA_API_TOKEN` only for a validated owner) →
proxies to `AGENT_ROUTER_ORIGIN_HOST` (`eliza-production-1.eliza.app` /
`eliza-staging-1.eliza.app`, set in `wrangler.toml`) → **nginx on the
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
- Public domain: `tunnel.eliza.app` + wildcard `*.tunnel.eliza.app` (staging
  uses `tunnel-staging.eliza.app`).
- Deploy authority: the protected `deploy-tunnel-proxy.yml` workflow validates
  the exact Railway IDs and canonical host variables, rotates the Headscale
  proxy preauth key, converges variables/volume/domains, deploys this service,
  and runs live health plus unsigned-host rejection checks. Railway domain
  attachment is handled there; Cloudflare CNAME/TXT is a separate credential
  boundary. The workflow normalizes and deduplicates Railway's exact DNS
  response, then requires it to match the protected
  `RAILWAY_TUNNEL_DNS_RECORDS_JSON` inventory. The `pages-domains` Terraform
  root owns/imports that inventory as DNS-only records so Railway terminates
  nested-wildcard TLS without Cloudflare Advanced Certificate Manager.
- Provisioning runbook: [`packages/cloud/services/headscale/DEPLOY.md`](../../services/headscale/DEPLOY.md) (covers both services).

### `gateway-discord` / `gateway-webhook`

Docker/Bun services with `railway.toml` manifests. `gateway-discord` retains
its Railway watched-branch deployment and `cloud-gateway-discord.yml` runs its
repository tests. `gateway-webhook` has no Railway repo trigger: the protected
`deploy-gateway-webhook.yml` dispatcher is its only deployment authority. It
binds staging to `develop` and production to `main`, validates the exact
Railway identities and canonical routing variables, uploads the exact dispatch
SHA from the repository root with a byte-identical root copy of the
tracked service manifest, and verifies the returned deployment id, applied
Dockerfile/health metadata, active-deployment identity around the public
probes, live `/health`, and the dedicated headerless
`/ready/forwarder-auth/eliza-app` contract. That read-only route returns its
exact 401 only when the forwarding secret gate is active for `eliza-app`;
disabled or project-mismatched configurations fail with distinct non-401
states without entering provider handling. Required runtime variables are
documented in each service's `railway.toml` header; the names-only sensitive
inventory includes the mandatory `ELIZA_APP_WEBHOOK_GATEWAY_SECRET` forwarding
trust gate. The old AWS EKS/Terraform/Helm deploy jobs were
removed with the AWS retirement
([`AWS_RETIREMENT.md`](./AWS_RETIREMENT.md)).

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
  explicit operator action, **off by default**;
  new code should not target it.
