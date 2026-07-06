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
bun run --cwd packages/cloud/services/gateway-webhook typecheck   # tsgo --noEmit
bun run --cwd packages/cloud/services/gateway-webhook test        # bun test
bun run --cwd packages/cloud/services/gateway-webhook lint        # biome check
bun run --cwd packages/cloud/services/gateway-webhook docker:build
```

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
- `PORT` (default 3000; `dev`/`start` scripts set 3002), `POD_NAME` /
  `HOSTNAME`.
- `KEDA_COOLDOWN_SECONDS` (default 900) — TTL on the KEDA activity key.
- `TWILIO_PUBLIC_URL`, `TWILIO_SMS_COST_PER_SEGMENT_USD` — Twilio adapter /
  billing tuning.
- Per-project secrets are read via `getProjectEnv(project, KEY)`: labeled k8s
  Secrets first, else `<PROJECT_UPPER>_<KEY>` env vars (e.g. `eliza-app` →
  `ELIZA_APP_TELEGRAM_BOT_TOKEN`). Keys include `DEFAULT_AGENT_ID`,
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

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../../../AGENTS.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
