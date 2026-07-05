# @elizaos/gateway-discord

Multi-tenant Discord gateway service for Eliza Cloud. A standalone, stateless
Hono HTTP service that maintains Discord WebSocket (gateway) connections for many
bots from one pod, transcribes voice messages, and forwards events to
agent-server pods. It is deployed as its own container (Docker / Railway), not
loaded as an Eliza plugin.

## Layout

- `src/index.ts` — entrypoint. Boots the Hono HTTP server and a single
  `GatewayManager`; exposes `/health` (liveness), `/ready` (readiness), `/drain`
  (preStop graceful drain), `/metrics` (Prometheus text), and `/status`. Wires
  `SIGTERM`/`SIGINT` to graceful shutdown.
- `src/gateway-manager.ts` — the bulk of the service (`GatewayManager`): polls
  Redis for bot assignments, opens `discord.js` `Client` connections, heartbeats
  pod state, handles failover, and runs Eliza App system-bot leader election.
- `src/server-router.ts` — resolves the agent-server for an agent via Redis and
  forwards messages with consistent-hash routing, retries, KEDA activity
  refresh, and K8s scale-from-zero wake-up (`forwardToServer`,
  `resolveAgentServer`, `refreshKedaActivity`).
- `src/hash-router.ts` — consistent hash ring (`hashring`) over agent-server pod
  IPs, resolved from K8s EndpointSlices; falls back to the URL directly for
  non-`.svc` (direct host:port) targets.
- `src/redis-adapter.ts` — `UpstashCompatRedis`, an Upstash-`@upstash/redis`-shaped
  facade over an `ioredis` client. `createNativeRedis(url)` for real TCP Redis,
  `createMockRedis()` (backed by `ioredis-mock`) for tests/CI.
- `src/voice-message-handler.ts` — downloads Discord voice attachments, uploads
  them to the Cloud API storage proxy, and produces pre-signed URLs
  (`VoiceMessageHandler`, `hasVoiceAttachments`).
- `src/logger.ts` — `createServiceLogger("gateway-discord")` from
  `@elizaos/cloud-services-common`.
- `tests/` — Vitest/`bun test` specs (hash-router, leader-election,
  redis-adapter, voice-message-handler).
- `Dockerfile`, `docker-compose.yml`, `railway.toml`, `scripts/deploy-railway.sh`
  — container build and deploy.

## Key scripts

Scope everything with `--cwd packages/cloud/services/gateway-discord`:

```bash
bun run --cwd packages/cloud/services/gateway-discord dev        # watch (PORT=3001, uses root .env.local)
bun run --cwd packages/cloud/services/gateway-discord dev:local  # watch, no env-file
bun run --cwd packages/cloud/services/gateway-discord build      # bun build -> dist (node target, zlib-sync external)
bun run --cwd packages/cloud/services/gateway-discord typecheck  # tsgo --noEmit
bun run --cwd packages/cloud/services/gateway-discord test       # bun test
bun run --cwd packages/cloud/services/gateway-discord lint       # biome check
bun run --cwd packages/cloud/services/gateway-discord docker:build / docker:up / docker:logs
bun run --cwd packages/cloud/services/gateway-discord deploy:railway
```

## Environment variables

Required at startup (the process `exit(1)`s if missing):

- `GATEWAY_BOOTSTRAP_SECRET` — exchanged at startup for a JWT against the Cloud API.

Connection / routing:

- `ELIZA_CLOUD_URL` (falls back to `NEXT_PUBLIC_APP_URL`, then `https://elizacloud.ai`)
- `REDIS_URL` (or `KV_REST_API_URL`) and `KV_REST_API_TOKEN` — Redis/Upstash.
- `AGENT_SERVER_SHARED_SECRET` — sent as `X-Server-Token` when forwarding to agent-servers.
- `POD_NAME` — required in production (K8s downward API); falls back to `gateway-<hostname>`
  for local dev only, which can orphan connections on reschedule.
- `PORT` (default 3000), `PROJECT` (log tag, default `cloud`).

Optional features / toggles:

- `MOCK_REDIS=1` — explicit opt-in to the in-memory mock Redis (tests/CI only).
- `ELIZA_APP_DISCORD_BOT_ENABLED=true` + `ELIZA_APP_DISCORD_BOT_TOKEN` — run the
  Eliza App system bot; `ELIZA_APP_LEADER_KEY` (default `discord:eliza-app-bot:leader`)
  for leader election.
- `VOICE_MESSAGE_ENABLED` (`"false"` disables the voice path),
  `VOICE_AUDIO_TTL_SECONDS`, `VOICE_CLEANUP_INTERVAL_MS`,
  `CLOUD_API_BASE_URL`/`ELIZAOS_CLOUD_BASE_URL`, `BLOB_READ_WRITE_TOKEN` — voice upload.
- `KEDA_COOLDOWN_SECONDS` (default 900).

## Conventions / gotchas

- Independent service: its own `package.json`, lockfile, `tsconfig` (`strict`,
  bundler resolution), and Biome config — not part of the Turbo project build.
  Build is `bun build` to `dist`, run with `bun run dist/index.js`.
- Use the package `logger` (never `console`); error messages are run through
  `sanitizeError` to redact anything matching the Discord bot-token pattern —
  never log raw tokens or full Discord payloads.
- `/health` returns 200 even when degraded (restarting would disconnect every
  bot); only `unhealthy` returns 503. `/ready` is the load-balancer signal and
  returns 503 while draining/degraded.
- Redis is real by default; the mock is only used when `MOCK_REDIS=1` is set
  explicitly — it is never silently substituted.
- `hash-router`/`server-router` read the K8s service-account token and CA from
  `/var/run/secrets/...`; absent (e.g. on Railway), they degrade gracefully and
  treat targets as direct host:port URLs rather than scaling a K8s Deployment.
- `discord.js` pulls in optional native deps; `build` marks `zlib-sync` external,
  so keep it (and other native modules) out of the bundle.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../../../AGENTS.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../../PR_EVIDENCE.md)**. Read it.
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
