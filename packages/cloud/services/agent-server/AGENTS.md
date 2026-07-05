# @elizaos/agent-server

The cloud **agent-server**: an Elysia HTTP service that hosts live Eliza agent
runtimes inside a pod. It loads one or more `AgentRuntime`s, forwards user
messages and structured events to them, exposes in-process workflow management,
and publishes its server/agent state to Redis so the gateway can route traffic
to the right pod.

## Layout

```
src/
  index.ts          entrypoint — env checks, boots AgentManager, mounts routes, listens; SIGTERM drain
  config.ts         env helpers: ensureServerName, getRequiredEnv, getAdvertisedServerUrl (Railway/K8s aware)
  redis.ts          shared ioredis client (getRedis); MOCK_REDIS=1 swaps in ioredis-mock for tests
  logger.ts         createServiceLogger("agent-server") from @elizaos/cloud-services-common
  agent-manager.ts  AgentManager — runtime lifecycle, in-flight drain tracking, Redis heartbeat, message/event entry points
  routes.ts         createRoutes(manager, sharedSecret) — Elysia route tree (see below)
  handlers/event.ts dispatchEvent + EventBodySchema (zod) — routes cron | notification | system events
__tests__/unit/     bun:test unit tests (config, event handler, metadata helpers, redis mock)
Dockerfile          oven/bun base; runs `bun run src/index.ts`; /health HEALTHCHECK on port 3000
```

### Routes (`createRoutes`)

- `GET /health`, `GET /ready` (503 while draining) — probes, unauthenticated.
- `GET /status` — server + agent snapshot.
- `POST /agents`, `POST /agents/:id/stop`, `DELETE /agents/:id` — runtime lifecycle.
- `POST /agents/:id/message` — forward a user message; optional `platformName` /
  `senderName` / `chatId` metadata.
- `POST /agents/:id/event` — forward a `cron` | `notification` | `system` event.
- `/agents/:id/workflows*` — list/get/deploy/generate/update/delete/activate/deactivate
  workflows via the runtime's in-process `workflow` service (`@elizaos/plugin-workflow`).
- `POST /drain` — graceful drain.

All routes except `/health` and `/ready` require internal service auth.

## Scripts

Scope with `--cwd packages/cloud/services/agent-server`:

```bash
bun run --cwd packages/cloud/services/agent-server start            # bun run src/index.ts
bun run --cwd packages/cloud/services/agent-server dev              # bun --watch run src/index.ts
bun run --cwd packages/cloud/services/agent-server typecheck        # tsgo --noEmit
bun run --cwd packages/cloud/services/agent-server lint             # biome check .
bun run --cwd packages/cloud/services/agent-server test             # bun test
bun run --cwd packages/cloud/services/agent-server test:unit        # bun test __tests__/unit/
bun run --cwd packages/cloud/services/agent-server test:integration # __tests__/integration/ (pass-with-no-tests)
```

## Environment variables

Required at boot (process exits 1 if any is missing):
`SERVER_NAME`, `REDIS_URL`, `DATABASE_URL`, `CAPACITY`, `TIER`,
`AGENT_SERVER_SHARED_SECRET`.

- `DATABASE_URL` is mapped to `POSTGRES_URL` for `@elizaos/plugin-sql` if the
  latter is unset.
- `AGENT_SERVER_SHARED_SECRET` is the internal service-to-service token; callers
  send it via `X-Server-Token` or `Authorization: Bearer`.
- `SERVER_NAME` is auto-derived from `RAILWAY_SERVICE_NAME` / `RAILWAY_SERVICE_ID`
  when not set explicitly (`ensureServerName`).
- Optional: `PORT` (default `3000`), `AGENT_ID` + `CHARACTER_REF` (auto-start one
  agent at boot — `CHARACTER_REF` is required when `AGENT_ID` is set),
  `AGENT_SERVER_URL` / `RAILWAY_PRIVATE_DOMAIN` / `RAILWAY_PUBLIC_DOMAIN` /
  `POD_NAMESPACE` (advertised URL), `ELIZAOS_CLOUD_API_KEY` / `OPENAI_API_KEY`
  (model plugin selection), `SKIP_MIGRATIONS`, `REDIS_STATE_TTL_SECONDS`
  (default 120, floored at 60), `MOCK_REDIS=1` (in-memory Redis for tests).

## Conventions / gotchas

- **Model plugin priority:** when an agent starts, `ELIZAOS_CLOUD_API_KEY`
  (the elizacloud proxy plugin) is preferred over `OPENAI_API_KEY`. `plugin-sql`
  and `plugin-workflow` are always loaded.
- **Capacity is reserved before init:** `startAgent` inserts a `stopped` slot
  first so concurrent requests can't exceed `CAPACITY`, then upgrades to
  `running`; the slot is removed if initialization throws.
- **Redis is routing state, not storage.** The heartbeat refreshes
  `server:<name>:status`/`:url` and `agent:<id>:server` with TTLs. On shutdown
  only the server status/url keys are deleted — agent→server mappings persist
  across scale-down so the gateway can still route.
- **Graceful drain:** SIGTERM (and `POST /drain`) marks the server `draining`
  (so `/ready` returns 503 and `/agents/:id/event` returns 503), waits up to 50s
  for in-flight messages/events, then stops runtimes. Every message/event path
  increments/decrements `inFlight` so drain waits for them.
- **Event types are app-level strings**, not core `EventType` values — dispatch
  uses `runtime.emitEvent("cron" | "config-reload", …)`; plugins opt in via
  `Plugin.events`. Event bodies are validated with `EventBodySchema` (zod);
  `userId` is regex-constrained to prevent path traversal.
- **Known platforms** (`telegram`, `whatsapp`, `twilio`, `blooio`) are duplicated
  here and must stay in sync with the gateway-webhook adapters and the app
  webhook config; unrecognized `platformName` falls back to source `agent-server`.
- **PII discipline:** `senderName` and `chatId` are never logged.

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
