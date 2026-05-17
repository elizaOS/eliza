# Cloud mock stack

End-to-end, in-process mocks for the Eliza Cloud control path: Hetzner API,
container control-plane, Redis, and Postgres. Lets `cloud-api`, `cloud-frontend`,
and `cloud-services` run with zero external dependencies for local development,
PR CI, and reproducible debugging.

## Why

Real Eliza Cloud needs a Hetzner API token, a Postgres instance (Neon in prod),
and either an Upstash Redis or a self-hosted RESP2 endpoint. None of those are
available on a fresh developer machine or in PR CI without provisioning secrets.
Worse, every test that touched the provisioning lifecycle either hit real
Hetzner (slow, costs money, leaks servers) or stubbed each call site
individually (drifts from reality). The mock stack closes both gaps: it boots
the full `cloud-api → control-plane → Hetzner` pipe against in-memory state and
plays the action lifecycle out on real timers, so the same code paths run in
tests as in prod.

## Topology

```
+------------------+        +------------------+        +-----------------+
|  cloud-frontend  | <----> |     cloud-api    | <----> | control-plane-  |
|   (Vite :dyn)    |   HTTP |  (wrangler :dyn) |   HTTP |   mock (:dyn)   |
+------------------+        +---------+--------+        +--------+--------+
                                      |                          |
                       +--------------+----+              +------+-------+
                       |                   |              |              |
                       v                   v              v              v
                 +-----------+      +-------------+   +-----------+   +-----+
                 |  PGlite   |      | MemoryRedis |   | Hetzner   |   | SSE |
                 |  TCP :dyn |      | (ioredis-   |   |   mock    |   |bridge|
                 | (DATABASE_|      |   mock)     |   |  (:dyn)   |   +-----+
                 |    URL)   |      | MOCK_REDIS=1|   | /v1 prefix|
                 +-----------+      +-------------+   +-----------+
```

All ports are auto-picked by the e2e fixture (see
`packages/cloud-e2e/src/fixtures/stack.ts:53`). Standalone runs of the mock
binaries default to fixed ports (Hetzner 4567, control-plane 8791, PGlite per
`packages/scripts/cloud/admin/dev/pglite-server.ts`).

## Components

**Hetzner mock** — `packages/cloud-test-mocks/src/hetzner/`. Hono app mounted
under `/v1`, served via `Bun.serve`. Implements servers, server actions
(`poweroff`/`poweron`), actions polling, and volumes — the subset exercised by
`HetznerCloudClient` in
`packages/cloud-shared/src/lib/services/containers/hetzner-cloud-api.ts`. State
lives in `HetznerStore` (in-memory `Map`s, monotonic IDs starting at
`1_000_000`). Action lifecycle is driven by real `setTimeout`s through
`scheduleActionSuccess` (`progression.ts:29`); the delay is `MOCK_HETZNER_ACTION_MS`
(default 2000ms, tests use 30–50ms). Per-route latency comes from `LATENCY_TABLE`
in `latency.ts:6` and is disabled by `MOCK_HETZNER_LATENCY=0`.

**Control-plane mock** — `packages/cloud-test-mocks/src/control-plane/`. Hono
app implementing job lifecycle (`/jobs`, `/sandboxes/:id`), container CRUD,
JSON-RPC + SSE bridge, hot-pool/autoscale/deployment crons, admin warm-pool
endpoints, and the public compat-agents stub. The provisioning tick
(`processProvisionJob` in `server.ts:655`) makes real HTTP calls to the Hetzner
mock and polls actions until `success` — same wire path as production.
Wave 5a closed six previously-flagged fidelity gaps against the real impl:
`POST /api/v1/eliza/agents/:id/stream` SSE (`server.ts:439`), dual-token
auth via `x-container-control-plane-token` (`server.ts:111`), `GET` variants
for all cron routes (`server.ts:188`–`200`), `DELETE /api/compat/agents/:id`
(`server.ts:593`), `GET /api/v1/admin/warm-pool` reporting `currentSize` from
the live snapshot (`server.ts:533`), and `?limit` query support on the
provisioning cron (`server.ts:182`).

**Redis mock** — `packages/cloud-shared/src/lib/cache/mock-redis.ts`. When
`MOCK_REDIS=1`, `buildRedisClient` returns a `MockSocketRedis` duck-typed to
`SocketRedis` (`redis-factory.ts:36`). Opt-in only — it never shadows a real
`REDIS_URL` or `KV_REST_API_URL/TOKEN` pair. This preserves the
missing-creds warning added in PR #7747 so prod misconfigurations still
surface loudly.

**PGlite** — already the default for `DATABASE_URL` in dev. The e2e fixture
delegates PGlite lifecycle to `cloud-api-dev.mjs`, which spawns the TCP bridge
at `packages/scripts/cloud/admin/dev/pglite-server.ts` and runs migrations
before `wrangler dev` boots.

**Mockoon static catalogs** — `packages/cloud-test-mocks/mockoon/`. Two
Mockoon v6 environments shipping static responses for read-only catalog
endpoints: Hetzner (`/locations`, `/server_types`, `/images`, `/pricing`) and
control-plane (warm-pool, docker-nodes, cron snapshots, compat agent). Useful
when something external — a UI prototype, a docs example, a curl loop —
needs a long-lived stub without booting the stateful Hono mock.

## Env var matrix

| Var                            | Default                          | Controls                                                            |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------- |
| `MOCK_REDIS`                   | unset                            | `=1` selects in-memory `MockSocketRedis` instead of real Redis      |
| `MOCK_HETZNER_LATENCY`         | unset (uses table)               | `=0` disables all simulated latency in both Hetzner and CP mocks    |
| `MOCK_HETZNER_ACTION_MS`       | 2000 (mock), 30 (e2e), 50 (unit) | Action lifecycle duration in ms                                     |
| `CONTROL_PLANE_TICK_MS`        | 0 (off) / 50 (e2e) / 1000 (bin)  | Background provisioning tick interval; 0 = test mode (manual tick)  |
| `HCLOUD_API_BASE_URL`          | `https://api.hetzner.cloud/v1`   | Redirects the real `HetznerCloudClient` (line 18) to the mock URL   |
| `CONTAINER_CONTROL_PLANE_URL`  | unset                            | URL of the control-plane service consumed by cloud-api              |
| `CONTAINER_CONTROL_PLANE_TOKEN`| unset                            | Bearer + dual aux-token enforced by the control-plane mock when set |
| `HCLOUD_TOKEN`                 | unset                            | Bearer accepted by Hetzner mock; any non-empty string works         |
| `CRON_SECRET`                  | unset                            | Bearer required by cloud-api cron routes (e2e uses `test-cron-secret`) |
| `DATABASE_URL`                 | unset                            | Postgres connection string; e2e wires this to the PGlite TCP bridge |

## Known fidelity gaps

Honest list of remaining real-vs-mock differences flagged during Wave 5a:

- Hetzner mock returns deterministic IPv4 in the `49.x.x.x/8` range
  (`store.ts:62`); real Hetzner allocates from its actual pool.
- Hetzner action IDs are sequential from 1
  (`store.ts:38`); real IDs are large opaque integers.
- Action progression uses a single `setTimeout` flip from `running` →
  `success` — no intermediate `progress` values
  (`progression.ts:36`). Code that depends on watching `progress` climb won't
  see anything between 0 and 100.
- Control-plane SSE bridge emits a fixed sequence (3 ticks then `done` on
  `/bridge/stream`, 2 progress + 1 response on `/stream`)
  (`server.ts:427`, `server.ts:457`); real streams are open-ended.
- Hot-pool replenishment is best-effort and only triggered by an explicit cron
  hit (`server.ts:485`); production has its own scheduler cadence.
- Compat-agent `GET /api/compat/agents/:id` returns a single stub character
  regardless of `id` (`server.ts:616`).
- PGlite is single-process and does not exercise Neon-specific behavior
  (connection pooling, branch routing, read replicas).
- `MockSocketRedis` is `ioredis-mock`-backed — covers basic commands but does
  not enforce cluster semantics or Upstash REST quirks.

## Cross-references

- Operational runbook: [`packages/cloud-e2e/RUNBOOK.md`](../packages/cloud-e2e/RUNBOOK.md)
- Mock internals: [`packages/cloud-test-mocks/ARCHITECTURE.md`](../packages/cloud-test-mocks/ARCHITECTURE.md)
- E2E spec inventory: [`packages/cloud-e2e/README.md`](../packages/cloud-e2e/README.md)
- Mock package README: [`packages/cloud-test-mocks/README.md`](../packages/cloud-test-mocks/README.md)
