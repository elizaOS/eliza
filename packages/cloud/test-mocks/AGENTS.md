# @elizaos/cloud-test-mocks

Stateful, in-process mocks of the third-party cloud APIs that Eliza Cloud talks
to. They let unit / integration tests and local dev exercise the **real**
clients (e.g. the Hetzner autoscaler client in `@elizaos/cloud-shared`) without
hitting live provider APIs. State lives in memory and resets when the process
exits.

## Layout & exports

- `src/index.ts` — package entry; re-exports the Hetzner mock and
  `controlPlane` namespace.
- `src/hetzner/` (export `./hetzner`) — Hono mock of the subset of the Hetzner
  Cloud API the autoscaler exercises (servers, server actions, pollable
  `/actions/{id}`, volumes). `startHetznerMock()` boots a real HTTP server and
  returns `{ url, port, store, stop }`; `url` already includes the `/v1` prefix
  so it drops into `HCLOUD_API_BASE_URL`. Also exports `buildHetznerMockApp`,
  `HetznerStore`, and the `./types`. Helpers: `latency.ts` (simulated latency
  table), `progression.ts`, `store.ts`.
- `src/control-plane/` (export `./control-plane`) — Hono mock of the container
  control-plane (admin warm-pool, docker-nodes, cron jobs, compat agents, plus
  a job/sandbox store and a tickable job processor). `startControlPlaneMock()`
  returns `{ url, port, store, stop, tick, processDbBackedJobs, cleanupStuck }`.
  Also exports `buildControlPlaneApp`, `ControlPlaneStore`, and the
  `Job`/`JobStatus`/`JobType`/`Sandbox`/`SandboxStatus` types.
- `src/steward/` (export `./steward`) — stateful loopback mock for authenticated
  Steward platform-user deactivation and deletion calls used by account lifecycle E2E.
- `src/fetch-server.ts` — shared `startFetchServer(fetch, opts)`; uses
  `Bun.serve` when running under Bun, falls back to a `node:http` adapter
  otherwise.
- `src/provider-contract/` (export `./provider-contract`) — deterministic
  OAuth 2.0 Authorization Code + PKCE and refresh-rotation upstream, fixture
  HTTP/fault server, signed webhook sender, secret redaction, atomic
  policy/effect receipts aligned with core `EffectReceipt`, and
  capability-aware adapter conformance runner. OAuth clients, redirect URIs,
  accounts, tenant grants, and API credentials are provider-owned seeds;
  callers cannot select a tenant or mint a receipt after an effect.
- `fixtures/provider-contract/` — synthetic, commit-safe fixture convention.
- `provider-contract-inventory.json` — promoted managed-integration ratchet;
  audited by `bun run audit:provider-contracts` and the cloud CI workflow.
- `provider-contract-protected-integrations.json` — append-only integration ID
  ledger; it must exactly match the inventory's active and retired IDs and may
  never remove an ID that appears in reachable repository history. A removed
  production integration moves to `retiredIntegrations` with a reason; it does
  not retain a mock suite or promoted capability claim.
- `bin/hetzner-mock.ts`, `bin/control-plane-mock.ts` — standalone runnable
  entrypoints (bin names `hetzner-mock`, `control-plane-mock`).
- `mockoon/*.json` — **stateless** Mockoon environments for read-only endpoints
  (Hetzner catalog, control-plane read endpoints), for designer workflows /
  quick demos that don't need the stateful Hono mocks.
- `test/` — Vitest/`bun test` suites that drive the mocks (fidelity + extended
  control-plane, hetzner).

## Scripts

```bash
# Run the standalone servers (defaults: hetzner 4567, control-plane 8791)
bun run --cwd packages/cloud/test-mocks start:hetzner -- --port 4567
bun run --cwd packages/cloud/test-mocks start:control-plane

# Test
bun run --cwd packages/cloud/test-mocks test     # runs `bun test`

# Stateless Mockoon environments (requires mockoon-cli)
mockoon-cli start --data packages/cloud/test-mocks/mockoon/hetzner-static.json
mockoon-cli start --data packages/cloud/test-mocks/mockoon/control-plane-static.json
```

Use programmatically by awaiting `startHetznerMock` / `startControlPlaneMock`,
pointing the real client at the returned `url`, then calling `stop()` in
teardown.

## Conventions / gotchas

- **Private, no build.** `"private": true`, version `0.0.0`; `main`/`exports`
  point straight at `./src/*.ts` (Bun runs the TS directly — `tsconfig.json` is
  `noEmit`). Test runner is `bun test`.
- **`url` already has `/v1`.** The Hetzner mock mounts its Hono app under `/v1`,
  so assign `running.url` directly to `HCLOUD_API_BASE_URL` — don't append a
  prefix. Any non-empty `HCLOUD_TOKEN` is accepted.
- **Hetzner env knobs:** `MOCK_HETZNER_LATENCY=0` disables all simulated
  latency; action lifecycle duration defaults to 2000ms — pass `actionMs`
  (tests use ~50ms) so pollable `/actions/{id}` resolve to `success` quickly.
- **Control-plane ticking:** `tickMs` defaults to `0` (no background tick = test
  mode); drive job progression manually via `tick()`. The standalone bin sets a
  1000ms tick (`CONTROL_PLANE_TICK_MS`). It resolves its Hetzner target from
  the `hetznerUrl` option, else `HCLOUD_API_BASE_URL`, else the real Hetzner
  API — point it at a running Hetzner mock for end-to-end flows.
- **Standalone bin ports/env:** hetzner reads `--port`/`PORT` (default 4567) and
  `--action-ms`; control-plane reads `PORT`/`CONTAINER_CONTROL_PLANE_PORT`
  (default 8791), `HOST`, `CONTROL_PLANE_TICK_MS`, `HCLOUD_API_BASE_URL`.
- **Mockoon files are stateless** read-only fixtures — they do not share state
  with the Hono mocks; use the Hono mocks when behavior depends on prior writes.

## Managed provider contract suites

Import `startFakeProvider` and `runProviderAdapterConformance` from
`@elizaos/cloud-test-mocks/provider-contract`. Exercise the real adapter over
the fake's loopback URL; never replace the client, OAuth callback parser, or
webhook handler under test. Declare only capabilities the adapter owns and
implement every always-required and capability-derived scenario; an explicit
`requiredScenarios` list may add coverage but cannot narrow the contract. The
reusable harness itself covers the full
scenario catalog, including OAuth state/PKCE and credential rotation, response
and transport faults, webhook ordering/idempotency, tenant denial, redaction,
and policy receipts.

Choose `outbound-http` for adapters that initiate provider requests and
`inbound-webhook` for provider-authenticated delivery routes. Profiles are
additive mandatory scenario sets, are bound into the nonce report, and cannot
be narrowed by a suite. OAuth callback/state/PKCE and refresh-token lifecycle
are separate capabilities so an adapter never claims a credential consumer it
does not implement.

To promote another managed integration:

1. Add deterministic synthetic fixture data under
   `fixtures/provider-contract/` when shared data is useful.
2. Add a contract suite that starts the fake upstream and invokes the real
   adapter through HTTP/OAuth/webhook boundaries.
3. Add the package declaration
   `elizaos.managedIntegration = { promoted: true, contractId: "..." }`.
4. Add the matching inventory entry with the exact adapter name and capabilities.
5. Append its ID to `provider-contract-protected-integrations.json`; never
   remove or rename an existing ledger ID.
6. Run the suite and `bun run audit:provider-contracts`; the audit executes the
   suite and verifies its nonce-bound observation report.

Do not put provider credentials or production captures in fixtures. Sandbox
and live lanes are opt-in evidence only and may not be required for fork pull
requests.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
