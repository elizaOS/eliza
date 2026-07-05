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
- `src/fetch-server.ts` — shared `startFetchServer(fetch, opts)`; uses
  `Bun.serve` when running under Bun, falls back to a `node:http` adapter
  otherwise.
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
bun run --cwd packages/test/cloud-mocks start:hetzner -- --port 4567
bun run --cwd packages/test/cloud-mocks start:control-plane

# Test
bun run --cwd packages/test/cloud-mocks test     # runs `bun test`

# Stateless Mockoon environments (requires mockoon-cli)
mockoon-cli start --data packages/test/cloud-mocks/mockoon/hetzner-static.json
mockoon-cli start --data packages/test/cloud-mocks/mockoon/control-plane-static.json
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

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../../AGENTS.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
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

**Capture & manually review for this package — eval / trajectory harness:**
- A live-model scenario run producing the JSON report + run viewer + native jsonl, with the trajectory **opened and reviewed**.
- The harness's own e2e tests against a real `AgentRuntime` — not a mocked runtime; assert **outcomes**, not routing (see #9970).
- Determinism/seed handling and the failure/partial-run reporting paths.
- The shape of the corpus/records emitted, inspected by hand.
<!-- END: evidence-and-e2e-mandate -->
