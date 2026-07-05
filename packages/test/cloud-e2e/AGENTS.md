# @elizaos/cloud-e2e

Full-stack, mock-backed Playwright end-to-end suite for the cloud-api +
cloud-frontend. Each worker boots a real local cloud stack — PGlite over a TCP
bridge, an in-process Hetzner mock, a container-control-plane sidecar with the
`ELIZA_TEST_SANDBOX_PROVIDER=memory` provider, the cloud-api Worker as a Node
subprocess, and (optionally) cloud-frontend via `vite dev` — then drives real
flows (SIWE login, provisioning, billing, monetization, app deploys) against it.
No real cloud credentials are needed; everything runs locally.

## Layout

```
playwright.config.ts   single chromium project, serial (workers: 1, fullyParallel: false)
tests/*.spec.ts        one spec per flow (siwe-login, provision, deprovision,
                       billing-provision, monetized-full-loop, example-*-real-deploy, …)
src/fixtures/
  stack.ts             startCloudStack() — boots/tears down the whole stack per worker
  env.ts               buildSharedEnv() — test flags/secrets for spawned subprocesses;
                       exports PLAYWRIGHT_TEST_AUTH_SECRET
  seed.ts              SeededUser type + direct DB seeding
  mock-llm.ts          mock LLM responses for monetization/journey specs
src/helpers/
  test-fixtures.ts     Playwright `test`/`expect` extension; exposes the worker-scoped
                       `stack` fixture and the per-test `seededUser`/`authenticatedPage`
  wallet-login.ts      loginWithTestWallet / loginAsSeededUser — real SIWE handshake
  provisioning.ts, monetization.ts, seed-pricing.ts, showcase.ts  flow helpers
docs/                  coverage write-ups (monetized loop, showcase apps)
```

Specs import `{ test, expect }` from `src/helpers/test-fixtures`, not from
`@playwright/test` directly, so they get the booted `stack` and the real-login
`seededUser`.

## Scripts

This package is private (`@elizaos/cloud-e2e`, version `0.0.0`) and not built —
there is no `build`; `typecheck` is `tsc --noEmit`. Tests are run with Playwright
under Bun with the `eliza-source` condition.

```bash
# scoped to this package
bun run --cwd packages/test/cloud-e2e test          # headless
bun run --cwd packages/test/cloud-e2e test:headed    # show the browser
bun run --cwd packages/test/cloud-e2e test:ui        # Playwright UI mode
bun run --cwd packages/test/cloud-e2e typecheck

# root aliases (same thing)
bun run cloud:e2e
bun run cloud:e2e:headed
bun run cloud:e2e:ui

# real-wallet SIWE login gate (dev/CI), separate from the suite
bun run cloud:login:test-wallet            # defaults to https://api.elizacloud.ai
bun run cloud:login:test-wallet --base <local-stack-url>
```

## Conventions / gotchas

- **Bun + `eliza-source` condition is mandatory.** The `test` scripts run
  `bun --conditions=eliza-source playwright ...` so Bun drives the package
  command while Playwright workers use Node. The config / `buildSharedEnv`
  re-inject `--conditions=eliza-source` into `BUN_OPTIONS` so spawned Bun
  subprocesses resolve workspace source (notably plugin-sql's peer dep on core).
  Running Playwright without it will mis-resolve packages.
- **`NODE_ENV=test` and KMS pinned in config.** `playwright.config.ts` sets
  `NODE_ENV ??= "test"` and `ELIZA_KMS_BACKEND ??= "memory"` before cloud-shared
  crypto is imported — the runner seeds/encrypts keys in-process (not a
  subprocess), so without this `seedTestUser()` throws on the `steward` KMS
  backend.
- **The memory sandbox provider is test-gated.** Guarded by `NODE_ENV=test` or
  `CLOUD_E2E=1`; it is not selectable in production.
- **`seededUser` uses the REAL login path.** It runs the genuine SIWE handshake
  (nonce → sign with a throwaway viem wallet → verify) against the booted
  cloud-api, then elevates that fresh wallet account to the privileged baseline
  (admin role, funded org) via a direct DB update. `seedTestUser`
  (direct row insert) is kept only for secondary identities (attacker /
  other-user / end-user). The worker runs with `MOCK_REDIS=1` (shared in-process
  store) so the SIWE nonce survives between the two requests.
- **`authenticatedPage` skips when no frontend is booted.** Stacks started with
  `frontend: false` have no `stack.urls.frontend`; the fixture `test.skip`s
  instead of crashing.
- **Serial only.** `workers: 1`, `fullyParallel: false`; one stack boot per
  worker (worker-scoped `stack` fixture, 240s boot timeout, 120s per-test).
- **Env layering.** The config loads `packages/cloud/shared/.env[.local]` into
  `process.env` without overriding shell values, so provider keys (e.g.
  `CEREBRAS_API_KEY` for real-LLM lanes) reach both the runner and the worker.
- **Per-run logs and recordings are gitignored.** Subprocess stdout/stderr
  stream to `.logs/`; Playwright artifacts go to `test-results/` (or, with
  `E2E_RECORD`, to `e2e-recordings/cloud-e2e/`).
- **Do not modify cloud-api / cloud-frontend source from inside this package.**
  When a spec exposes a real bug, surface it as a follow-up instead of patching
  product code here. Mocks live in `packages/test/cloud-mocks`
  (`@elizaos/cloud-test-mocks`).

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
