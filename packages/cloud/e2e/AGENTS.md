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

### Exact-three agent stability lane

`stability:keyless` boots the canonical mock Cloud stack once per isolated
attempt, runs a real `AgentRuntime`, and requires attempts 1, 2, and 3 to pass.
The scenario sends a real owner message, executes `OWNER_REMINDERS`, fires the
production scheduler through a retained notification sink, and proves
authenticated Hetzner mock create/read/delete effects through an audit proxy.
Strict deterministic fixtures are the only model in the PR lane.

`stability:real -- --provider openai|anthropic` runs the identical scenario,
world, plugins, services, and mock endpoints while replacing only the model.
The selected provider is forced through a bounded loopback proxy; a pinned-Bun
preload rejects direct child fetch and Node HTTP(S) egress. The outer adapter
conveys exactly one selected `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` and its
per-attempt receipt key over a bounded inherited pipe, never the harness
environment. The trusted attempt harness consumes and closes that descriptor
before starting the mock stack; the scenario child receives only a dummy SDK
key. Real service credentials are injected only at the provider proxy. Before
dispatch, the proxy requires the exact target model, rejects
provider-hosted context/tools and non-text inputs, and injects or clamps the
route-specific output cap to the remaining budget. Its conservative input
envelope charges the larger canonical/original UTF-8 body size plus an 8,192
token hidden-overhead reserve; this is not provider tokenization, so returned
OpenAI or Anthropic usage remains the authoritative postflight count. Missing,
malformed, over-budget, oversized, or unmetered responses fail closed, and the
manifest's 16-request ceiling remains binding.
Accepted request evidence binds the exact canonical upstream byte length and
SHA-256; rejected requests retain structural evidence without a forwarded hash.
The trusted attempt harness signs the complete real-model receipt with the
parent-owned, per-attempt HMAC key; the outer adapter verifies that attestation
before accepting it.
On Linux the scenario runs as a fresh per-attempt unprivileged host UID, mapped
to UID 0 only inside a new user namespace, with no capabilities, a new PID and
`/proc` namespace, a read-only repository, bounded resources,
AF_INET/AF_INET6-only seccomp, and owner-scoped firewall rules admitting only
declared loopback proxy ports. The root launcher clears its environment and
consumes only a strict caller-owned environment file before deleting it. The
pinned-Bun preload remains application-level diagnostics; private `/run`,
`/tmp`, and `/var/tmp` mounts plus syscall denial for `socketpair` and all
io_uring entry points close host AF_UNIX delegation paths. The kernel boundary
also rejects direct TCP, UDP, DNS, and raw-socket bypasses.

Attempts retain trajectories, tool receipts, transitions, bounded logs,
network and mock-service ledgers, and authority hashes. The aggregate retains
first-attempt success, failure clusters, 3/3 status, a canonical report hash,
and the asserted three-cycle seed/reset ledger. Failures still upload evidence.

The lane composes #24081, #24136, #24209, and pending #24344. Until those stacks
land together, source runs need their exact dependency heads; real-model proof
remains blocking unless an authorized repository secret produced a trajectory.

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
