# @elizaos/cloud-test-mocks — internal architecture

How the in-process mocks are wired. For the bigger picture (where they sit in
the cloud stack, what env vars they respect, known fidelity gaps), see
[`/docs/cloud-mock-stack.md`](../../docs/cloud-mock-stack.md).

## Module layout

```
src/
  index.ts                  Barrel: re-exports hetzner/* and `controlPlane` namespace
  hetzner/
    index.ts                startHetznerMock — Bun.serve wrapper, mounts app under /v1
    server.ts               buildHetznerMockApp — Hono routes + auth middleware
    store.ts                HetznerStore — in-memory Maps, ID allocation, known locations
    progression.ts          createAction + scheduleActionSuccess + per-resource schedulers
    latency.ts              LATENCY_TABLE, injectLatency (MOCK_HETZNER_LATENCY=0 disables)
    types.ts                MockServer, MockVolume, MockAction, ErrorEnvelope, MockLocation
  control-plane/
    index.ts                startControlPlaneMock — Bun.serve + optional background tick
    server.ts               buildControlPlaneApp — all routes, tick(), cleanupStuck()
    store.ts                ControlPlaneStore — sandboxes, jobs, containers, warm pool, crons
bin/
  hetzner-mock.ts           Standalone runner (parses --port, --action-ms)
  control-plane-mock.ts     Standalone runner (reads PORT, HOST, CONTROL_PLANE_TICK_MS, …)
mockoon/
  hetzner-static.json       Mockoon v6 env — Hetzner read-only catalog stubs
  control-plane-static.json Mockoon v6 env — control-plane catalog stubs
```

## State model

Each mock owns one in-process store. Both stores are plain TypeScript classes
backed by `Map`s — no persistence, no shared global. Each `start*Mock()` call
constructs a fresh store unless the caller passes one via the `store` option.

`HetznerStore` (`hetzner/store.ts`) holds `servers`, `actions`, `volumes` and
allocates monotonic IDs (servers start at `1_000_000`, volumes at `5_000_000`,
actions at `1`). `KNOWN_LOCATIONS` is a const table for `fsn1`/`nbg1`/`hel1`;
unknown names fall back to `fsn1`.

`ControlPlaneStore` tracks `sandboxes`, `jobs`, `containers`, a warm-pool
snapshot, per-cron counters, and warm-pool rollout state.

Action progression is **timer-driven, not poll-driven**. When a route creates
an action it calls `scheduleActionSuccess` (`hetzner/progression.ts:29`) which
arms a single `setTimeout` for `MOCK_HETZNER_ACTION_MS` (default 2000ms). On
fire it flips `status` from `running` to `success`, sets `progress = 100`,
and runs the supplied side-effect (e.g. delete the server, attach the volume).
Timers are `.unref()`ed so a leftover action never blocks process exit.

The control-plane hot-pool loop is opt-in via `tickMs` on
`startControlPlaneMock` (`control-plane/index.ts:50`). When `tickMs > 0` a
`setInterval` calls `tick()` continuously, which scans pending jobs and runs
the provisioning state machine. Unit tests pass `tickMs: 0` and drive
`tick()` manually for determinism; the e2e fixture uses 50ms.

## Latency model

Hetzner: per-endpoint `{p50, jitter}` in `LATENCY_TABLE`
(`hetzner/latency.ts:6`). For each request, `injectLatency(routeKey)` sleeps
`max(0, round(p50 + uniform(-jitter, +jitter)) * multiplier)`. Endpoints not
in the table fall back to `DEFAULT_ENTRY = { p50: 100, jitter: 30 }`.
`MOCK_HETZNER_LATENCY=0` short-circuits to immediate return — used by every
test path. The standalone binary leaves latency on so curl loops feel
realistic.

Control-plane: a single uniform 5ms delay applied via the local `latency()`
helper (`control-plane/server.ts:203`), gated by the same
`MOCK_HETZNER_LATENCY=0` flag. No per-route table — keeps the implementation
small and matches the real impl which is mostly bounded by its downstream
Hetzner calls.

## Auth model

Hetzner mock (`hetzner/server.ts:31`): a single middleware requires
`Authorization: Bearer <non-empty>`. Token value is not checked — any
non-empty string passes. Health endpoints are not exempt because the real
Hetzner API has none.

Control-plane mock (`control-plane/server.ts:101`): three-tier auth.
1. `/health`, `/api/v1/admin/*`, `/api/compat/*` skip the bearer check
   (admin routes use a separate `adminToken`; compat routes are public stubs).
2. Every other route requires `Authorization: Bearer <token>` matching the
   configured `token` (defaults to `CONTAINER_CONTROL_PLANE_TOKEN` env, then
   `"test-token"`).
3. If `expectedAuxToken` is set (default reads `CONTAINER_CONTROL_PLANE_TOKEN`
   env), requests must additionally carry
   `x-container-control-plane-token: <token>`. This mirrors the dual-token
   scheme on the real service.

Sandbox-scoped routes also call `requireForwardedAuth(c)` to enforce that
cloud-api proxied `x-eliza-user-id` and `x-eliza-organization-id` headers
through (`control-plane/server.ts:120`). Container reads/writes additionally
verify `container.organizationId === auth.organizationId`.

## Cookbook: adding a new endpoint to an existing mock

1. **Extend the store.** Add the field(s) to `HetznerStore` or
   `ControlPlaneStore`. Use `Map`s, never plain objects; add an allocator
   if you need a monotonic ID.
2. **Add the route.** Inside `buildHetznerMockApp` /
   `buildControlPlaneApp`, register the Hono handler. Pull auth from the
   existing middleware — do not add a new auth path.
3. **Wire latency.** For Hetzner, add an entry to `LATENCY_TABLE` and call
   `await injectLatency("METHOD /path")` first in the handler. For
   control-plane, call `await latency()`.
4. **Schedule any async progression** with `scheduleActionSuccess` so the
   timer is `.unref`ed for clean test exit.
5. **Cover it with a test.** Add to `packages/cloud-test-mocks/test/` and
   exercise the new field + the new route.

## Cookbook: adding a brand-new mock

1. `mkdir src/<name>` and mirror the Hetzner module shape: `index.ts`
   (start/stop wrapper), `server.ts` (Hono routes), `store.ts` (state),
   `types.ts` (DTOs). Add `progression.ts` / `latency.ts` only if needed.
2. Export from `src/index.ts` either flat (`export * from "./<name>"`) or
   namespaced (`export * as <name> from "./<name>"` — pattern used by
   `controlPlane`).
3. Add a `bin/<name>-mock.ts` standalone runner that parses port/host from
   env and calls the `start*Mock()` wrapper.
4. If applicable, ship a Mockoon static export under `mockoon/`.
5. Update [`/docs/cloud-mock-stack.md`](../../docs/cloud-mock-stack.md) with
   the new component + any new env vars in the matrix.
