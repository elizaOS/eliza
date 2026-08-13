# @elizaos/gateway-webhook

Stateless multi-platform webhook gateway for Eliza Cloud. It receives inbound
webhooks from chat/messaging platforms (Telegram, Blooio, Twilio, WhatsApp
Cloud API), verifies and deduplicates them, resolves the sender's Eliza
identity, and forwards the message to the correct agent-server pod over a
hash-ring router. It also accepts internal events (cron / notification /
system) from trusted in-cluster callers and forwards those to agents.

## Layout

- `src/index.ts` — entrypoint. Builds a Hono app served via `Bun.serve`, wires
  the platform adapters, and registers routes:
  - `GET /health`, `GET /ready`, `POST /drain` — liveness / readiness /
    graceful-drain (KEDA / k8s lifecycle).
  - `POST /internal/event` — internal event delivery (auth via
    `X-Internal-Secret`).
  - `GET /webhook/:project/whatsapp[/:agentId]` — WhatsApp `hub.challenge`
    verification handshake.
  - `POST /webhook/:project/:platform[/:agentId]` — platform message webhooks.
- `src/adapters/` — one `PlatformAdapter` per platform (`telegram`, `blooio`,
  `twilio`, `whatsapp`) plus `types.ts` (the `Platform`, `ChatEvent`,
  `PlatformAdapter`, `WebhookConfig` contracts). An adapter implements
  `verifyWebhook` / `extractEvent` / `sendReply` / `sendTypingIndicator`.
- `src/webhook-handler.ts` — the core flow: sync phase (resolve config → verify
  signature → extract event → dedup), then a fire-and-forget async phase
  (resolve identity → forward to agent-server → send reply). Unlinked senders
  are routed to the cloud onboarding chat.
- `src/server-router.ts` — `resolveIdentity`, `resolveAgentServer`,
  `forwardToServer` / `forwardEventToServer` (retry + fallback + KEDA
  wake-on-zero), and `refreshKedaActivity`.
- `src/hash-router.ts` — consistent-hash ring over agent-server pod IPs,
  resolved from k8s EndpointSlices; falls back to a direct target for non-`.svc`
  URLs.
- `src/auth.ts` — gateway service auth: bootstraps a JWT from the cloud API with
  `GATEWAY_BOOTSTRAP_SECRET` and auto-refreshes it; `getAuthHeader()` supplies
  the `Authorization` header for cloud calls.
- `src/internal-auth.ts` — constant-time `X-Internal-Secret` validation for
  `/internal/event`.
- `src/internal-event-handler.ts` — zod-validated internal event ingestion
  (64KB cap), then background forward.
- `src/webhook-config.ts` / `src/project-config.ts` — per-agent webhook config
  (fetched from the cloud API, Redis-cached) and per-project secrets (loaded
  from labeled k8s Secrets, refreshed on an interval, falling back to env vars).
- `src/redis.ts` — `GatewayRedis` abstraction over Upstash REST, native ioredis,
  or an in-memory mock.
- `src/billing.ts` — Twilio SMS segment + markup cost math (pure functions).
- `src/logger.ts` — `createServiceLogger("gateway-webhook")` from
  `@elizaos/cloud-services-common`.
- `__tests__/` and `src/__tests__/` — bun tests.
- `Dockerfile`, `railway.toml` — container build and Railway deploy config.

## Key scripts

Scope everything with `--cwd packages/cloud/services/gateway-webhook`:

```bash
bun run --cwd packages/cloud/services/gateway-webhook dev         # watch mode on PORT=3002
bun run --cwd packages/cloud/services/gateway-webhook start       # run src/index.ts (PORT=3002)
bun run --cwd packages/cloud/services/gateway-webhook build       # bun build src/index.ts → dist/ (node target)
bun run --cwd packages/cloud/services/gateway-webhook typecheck   # tsc --noEmit
bun run --cwd packages/cloud/services/gateway-webhook test        # bun test
bun run --cwd packages/cloud/services/gateway-webhook lint        # biome check
bun run --cwd packages/cloud/services/gateway-webhook docker:build
```

## Build & deploy

**The Docker build context is the repository root, not this directory.** The
service depends on the `@elizaos/cloud-services-common` workspace package, and
`workspace:*` cannot resolve from a context holding only this package:

```bash
docker build -f packages/cloud/services/gateway-webhook/Dockerfile .
railway up            # run from the repository root
```

The deps stage writes a pruned workspace root containing only this service and
the package it needs, so the install resolves the workspace link without pulling
the whole monorepo (32 packages, not several thousand).

This service has **no repo trigger on Railway** — nothing deploys it on push, so
merging a change to it does not ship it. Until that is wired, a release is a
manual `railway up` from the repository root, and the running image is whatever
was last built. `__tests__/dockerfile-workspace-context.test.ts` guards the
workspace-resolution half of this; nothing yet guards the deploy half.

## Environment

Required (the process throws on startup if these are missing):

- `ELIZA_CLOUD_URL` — base URL of the cloud API (identity resolve, webhook
  config, onboarding chat, auth token endpoints).
- `GATEWAY_BOOTSTRAP_SECRET` — bootstrap secret used to acquire the gateway JWT.

Redis (at least one of these must resolve, or `createRedis()` throws):

- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Upstash Redis REST.
- `REDIS_URL` — native Redis (ioredis).
- `MOCK_REDIS=1` — in-memory mock (tests / local).

Other:

- `GATEWAY_INTERNAL_SECRET` — required to accept `POST /internal/event`; when
  unset, every internal-event request is rejected (logged as a warning at boot).
- `AGENT_SERVER_SHARED_SECRET` — sent as `X-Server-Token` on forwards to
  agent-server pods.
- `AGENT_ROUTER_ORIGIN_HOST` — canonical dedicated-agent router origin used
  after a direct transport failure. The gateway sends the validated
  `<agent-id>.<ELIZA_CLOUD_AGENT_BASE_DOMAIN>` value as `X-Forwarded-Host`.
  Validation applies to the complete generated hostname, including the
  253-character total and 63-character per-label DNS limits.
- `ELIZA_CLOUD_AGENT_BASE_DOMAIN` — dedicated-agent hostname suffix used with
  the router origin (default `cloud.eliza.app`).
- `PORT` (default 3000; `dev`/`start` scripts set 3002), `POD_NAME` /
  `HOSTNAME`.
- `KEDA_COOLDOWN_SECONDS` (default 900) — TTL on the KEDA activity key.
- `TWILIO_PUBLIC_URL`, `TWILIO_SMS_COST_PER_SEGMENT_USD` — Twilio adapter /
  billing tuning.
- Per-project secrets are read via `getProjectEnv(project, KEY)`: labeled k8s
  Secrets first, else `<PROJECT_UPPER>_<KEY>` env vars (e.g. `eliza-app` →
  `ELIZA_APP_TELEGRAM_BOT_TOKEN`). Keys include
  `TELEGRAM_BOT_TOKEN`/`_WEBHOOK_SECRET`, `BLOOIO_*`, `TWILIO_*`, `WHATSAPP_*`.

## Conventions / gotchas

- **Stateless service.** All shared state lives in Redis (dedup keys, identity
  cache, webhook-config cache, KEDA activity, agent→server routing). The hash
  ring is rebuilt from k8s EndpointSlices, not persisted.
- **Ack fast, work later.** Webhook and internal-event handlers do the minimum
  synchronously and return 200 immediately, then process in a detached promise.
  Errors in the async phase are logged, not surfaced to the caller — watch the
  `[gateway-webhook]` logs for `Forward to server failed`, `No server found for
  agent`, etc. There is no dead-letter queue.
- **Two auth paths, do not confuse them:** outbound calls to the cloud API use
  the JWT from `auth.ts` (`getAuthHeader()`); inbound `/internal/event` is
  gated by `internal-auth.ts` (`X-Internal-Secret`, constant-time compare).
- **Dedup** is keyed on `webhook:<platform>:<messageId>` with a 5-minute TTL;
  adapters must produce a stable `messageId` in `extractEvent`.
- **Routing hash key is `userId`, not `agentId`** — same user's messages and
  events stick to the same agent-server pod for hot session affinity.
- **Twilio acks differ:** `ackResponse` returns empty TwiML for `twilio` and
  JSON `{ ok: true }` for everyone else.
- **Adding a platform:** implement a `PlatformAdapter`, register it in the
  `adapters` map in `index.ts`, and add the platform to the `Platform` union and
  the per-platform config block in `webhook-config.ts`. Keep `WebhookConfig`
  additive.
- **K8s-only features degrade gracefully:** EndpointSlice resolution, KEDA
  wake-on-zero (`wakeServer`), and labeled-Secret project config all no-op when
  the service-account token/CA are absent (local/dev), falling back to direct
  targets and env vars.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
