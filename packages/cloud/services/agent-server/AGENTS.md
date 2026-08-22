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
bun run --cwd packages/cloud/services/agent-server typecheck        # tsc --noEmit
bun run --cwd packages/cloud/services/agent-server lint             # biome check .
bun run --cwd packages/cloud/services/agent-server test             # bun test
bun run --cwd packages/cloud/services/agent-server test:unit        # bun test __tests__/unit/
```

## Environment variables

Required at boot (process exits 1 if any is missing):
`SERVER_NAME`, `REDIS_URL`, `DATABASE_URL`, `CAPACITY`, `TIER`,
`AGENT_SERVER_SHARED_SECRET`.

`CAPACITY` must be a canonical decimal integer from `1` through `200`; the
server validates it once before connecting to Redis and uses that numeric value
for status and admission until the process exits.

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
- **Known platforms** (`telegram`, `twilio`, `blooio`) are duplicated
  here and must stay in sync with the gateway-webhook adapters and the app
  webhook config; unrecognized `platformName` falls back to source `agent-server`.
- **PII discipline:** `senderName` and `chatId` are never logged.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
