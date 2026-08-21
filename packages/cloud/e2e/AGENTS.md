# @elizaos/cloud-e2e

Full-stack, mock-backed Playwright end-to-end suite for the cloud API and the
Cloud surfaces in `packages/app`. Each worker boots a real local cloud stack — PGlite over a TCP
bridge, an in-process Hetzner mock, a container-control-plane sidecar with the
`ELIZA_TEST_SANDBOX_PROVIDER=memory` provider, the cloud-api Worker as a Node
subprocess, and (optionally) `packages/app` via `vite dev` — then drives real
flows (SIWE login, provisioning, billing, monetization, app deploys) against it.
No real cloud credentials are needed; everything runs locally.

## Layout

```
playwright.config.ts   single chromium project, serial (workers: 1, fullyParallel: false)
tests/*.spec.ts        one spec per flow (siwe-login, provision, deprovision,
                       billing-provision, monetized-full-loop, domain purchase, …)
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
  provisioning.ts, monetization.ts, seed-pricing.ts  flow helpers
docs/                  coverage write-ups and live-operation runbooks
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
bun run --cwd packages/cloud/e2e test          # headless
bun run --cwd packages/cloud/e2e test:headed    # show the browser
bun run --cwd packages/cloud/e2e test:ui        # Playwright UI mode
bun run --cwd packages/cloud/e2e typecheck

# root aliases (same thing)
bun run cloud:e2e
bun run cloud:e2e:headed
bun run cloud:e2e:ui

# real-wallet SIWE login gate (dev/CI), separate from the suite
bun run cloud:login:test-wallet            # defaults to https://api.eliza.app
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
  worker (worker-scoped `stack` fixture, 360s boot timeout, 120s per-test).
- **Env layering.** The config loads `packages/cloud/shared/.env[.local]` into
  `process.env` without overriding shell values, so provider keys (e.g.
  `CEREBRAS_API_KEY` for real-LLM lanes) reach both the runner and the worker.
- **Per-run logs and recordings are gitignored.** Subprocess stdout/stderr
  stream to a unique `.logs/<run-id>/`; Playwright artifacts go to `test-results/` (or, with
  `E2E_RECORD`, to `e2e-recordings/cloud-e2e/`).
- **Synthetic mode is manifest-owned.** `stackOptions.synthetic` explicitly
  declares model mode, agent count, connector set, background workers,
  frontend targets, named provider environment bindings, and fault script.
  Test boundaries reset and compare the composite execution hash. Do not pass
  mock administrative credentials to production clients or subprocesses.
- **CI does not retry product failures.** Playwright `retries` is zero. Any
  future infrastructure retry belongs in a separately classified wrapper with
  evidence from the failed attempt.
- **Keep product fixes in their owning package.** This harness may expose bugs
  in `packages/cloud/api` or `packages/app`, but changes belong under those
  packages and must follow their local guides.
- Mocks live in `packages/cloud/test-mocks`
  (`@elizaos/cloud-test-mocks`).

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
