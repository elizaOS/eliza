# @elizaos/cloud-e2e

Full-stack mock-backed Playwright E2E for the cloud-api + cloud-frontend.

## What boots

1. **PGlite TCP bridge** (via `packages/cloud/scripts/admin/dev/pglite-server.ts`)
2. **Hetzner mock** in-process (`@elizaos/cloud-test-mocks/hetzner`)
3. **Real container-control-plane sidecar** with the explicit
   `ELIZA_TEST_SANDBOX_PROVIDER=memory` test provider
4. **cloud-api worker** subprocess via
   `packages/cloud/scripts/admin/dev/cloud-api-e2e-server.mjs`, a Node-hosted
   Worker fetch adapter
5. **cloud-frontend** subprocess via `vite dev`

Each subprocess streams stdout/stderr into `packages/cloud/e2e/.logs/`.

## Running

```bash
bun run cloud:e2e        # headless
bun run cloud:e2e:headed # show browser
bun run cloud:e2e:ui     # Playwright UI mode
```

Per-test the harness:

- seeds a fresh org + user + API key via cloud-shared repositories
- injects an `eliza-test-session` cookie signed with `PLAYWRIGHT_TEST_AUTH_SECRET`
- exposes `stack.mocks.hetzner.store` and `stack.urls.controlPlane` for assertions

### Linux stability source workspace

Native stability requires a credential-free, sandbox-readable checkout: its root
must permit other-user read/search and every ancestor must permit search. Private
home or temporary directories are rejected before privileged setup. Stage the
reviewed checkout in a dedicated readable workspace; do not loosen home permissions
or remove credential masks. Preserve source, dependency links, and build identity
when staging, and keep provider credentials outside the checkout.

### Real wallet login (no DB seeding)

`seedTestUser` inserts rows directly and never runs the login flow. To exercise
the REAL login path, use `loginWithTestWallet(stack.urls.api)`
(`src/helpers/wallet-login.ts`): it runs the genuine SIWE handshake
(nonce → sign with a throwaway viem wallet → verify) against the booted cloud-api
and returns a real API key for a free account. The stack runs the worker with
`MOCK_REDIS=1` (shared in-process store), so the SIWE nonce survives between the
two requests. `asSeededUser(login)` adapts the result to the `SeededUser` shape.

The same flow is available as a dev/CI gate: `bun run cloud:login:test-wallet`
(defaults to `https://api.eliza.app`; pass `--base <url>` for a local stack).
It exits non-zero if login or the authenticated probe fails.

**The `seededUser` fixture now uses this real path for every spec.** Instead of
inserting rows directly, it calls `loginAsSeededUser(stack.urls.api)`, which runs
the genuine SIWE handshake and then elevates the fresh wallet account to the
suite's privileged baseline (admin role, funded org, known verified email) via a
direct DB update — exactly the end-state `seedTestUser` produced. So every spec
that consumes `seededUser` authenticates with a credential the real login flow
minted, with no other changes. `seedTestUser` is kept for specs that need extra
secondary identities (attacker / other-user / end-user).

## Specs

| File                          | Covers                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `tests/siwe-login.spec.ts`    | real nonce → sign → verify mints a usable key; forged sig 401s; re-login is idempotent; fixture identity is real-login-minted |
| `tests/dashboard.spec.ts`     | seeded user reaches dashboard with test-auth session, localStorage writable   |
| `tests/account-deletion.spec.ts` | authenticated deletion page rejects query-string success claims, projects lifecycle unavailability, returns 409 to a confirmed request, and proves zero Steward/user/org/API-key/request or unrelated-tenant mutation |
| `tests/provision.spec.ts`     | create agent → cron tick → sandbox `running`, control-plane sees the sandbox  |
| `tests/deprovision.spec.ts`   | DELETE agent → async `agent_delete` job → polls to `deleted` / 404            |
| `tests/stuck-cleanup.spec.ts` | aged `provisioning` row with no job → cleanup cron → sandbox `error`          |
| `tests/domain-purchase-harness.spec.ts` | harness-logic verification for the money-gated domain-purchase lane against the registrar dev stub: full chain, price ceiling, ledger, 402/409/502-refund/idempotency negatives |
| `tests/domain-purchase.real.spec.ts` | **money-gated LIVE lane (#10691)** — real Cloudflare registration + credit debit; skips loudly unless `ELIZA_LIVE_DOMAIN_PURCHASE=1` + base URL + key are set. Operator runbook: [docs/domain-purchase-live.md](docs/domain-purchase-live.md) |

## Live domain purchase (real money, operator-gated)

`tests/domain-purchase.real.spec.ts` buys a real cheap-TLD domain (≤ 500¢
ceiling, enforced BEFORE buying) against staging/prod, proves it goes active
and serves, and appends every attempt to the append-only purchase ledger
(`domain-purchase-ledger/ledger.jsonl`, inspect with
`bun run domains:ledger`). CI never runs it — the whole suite honest-skips
unless the operator sets the money guard. Command, env matrix, ledger and
cleanup semantics: [docs/domain-purchase-live.md](docs/domain-purchase-live.md).

## Notes

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
malformed, over-budget, oversized, or unmetered responses fail closed.
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
`stability.json` is stored as bounded canonical JSON; its raw SHA-256 is the
exact digest in both `stability.sha256` and `manifest.json`. Verify retained
evidence before consuming it with
`bun run stability:verify -- --output <artifact-directory>`.
The verifier also checks the strict aggregate schema and a manifest self-hash
that binds `reportSha256`; artifact publication is staged, fsynced, and refuses
to overwrite a prior bundle.

The lane composes #24081, #24136, #24209, and pending #24344. Until those stacks
land together, source runs need their exact dependency heads; real-model proof
remains blocking unless an authorized repository secret produced a trajectory.

- The mocks live at `packages/cloud/test-mocks`; the harness imports from
  `@elizaos/cloud-test-mocks/hetzner`.
- `src/fixtures/mock-llm.ts` can take the same strict core fixture registry used
  by scenarios. Its loopback OpenAI adapter supports JSON and SSE completions,
  tool calls, usage, latency, declared provider errors, timeouts, and client
  cancellation. Fixed/echo replies remain compatibility fixtures for existing
  journeys; new tests should pass named fixtures and assert their consumption.
- The memory sandbox provider is guarded by `NODE_ENV=test` or `CLOUD_E2E=1`;
  it is not selectable in production.
- The cloud-api adapter avoids Wrangler in CI while still exercising the real
  generated router, Worker entrypoint, container-control-plane forwarder, and
  DB-backed provisioning queue.
- No real cloud creds are needed; everything is local.
- Do not modify cloud-api / cloud-frontend source from inside this package.
  When a test exposes a real bug, surface it as a follow-up.

### Native stability duration

The native lane defaults to 600,000 ms and rejects larger selected budgets before
allocation. Explicit shorter durations are preserved. The total success budget
includes both complete identity scans and native cleanup; slow or timed-out work
never becomes a passed report. Cancellation has a separately bounded cleanup
window, with retained reservations and adapter quarantine on unproven cleanup.
This accounts for measured metadata inspection exceeding 100 seconds on an
isolated Linux target without omitting scans or changing the payload CPU limit.
The nonnative fixture default remains 15,000 ms.

### Native authority installation

Run `scripts/install-native-stability.py --source-root <checkout>/packages/cloud/e2e/scripts`
with the trusted setup process's root authority before starting a scenario, then
pass its returned `installedRoot` through `--native-root` to `stability:keyless`
or `stability:real`. The installer creates a unique private directory under
`/opt`; it never overwrites an existing installation or changes kernel/security
policy. The reviewed checkout is the trusted build input. Its root path may use
a canonicalized alias such as `/tmp`, but source files and the `native-ledger`
subdirectory cannot be symlinks. Sources, actual compiler/tool binaries, kernel
BTF, generated header and build outputs are hashed in the retained receipt.

The supported target requires x86_64 Linux, systemd, cgroup v2, at least two
online CPUs, kernel BTF, clang-18, the kernel's packaged bpftool, libbpf/libelf/zlib
development packages, and the existing bubblewrap/iptables/ACL boundary. The
host must already permit bubblewrap user namespaces under its security policy.
The executed native controls use Ubuntu's 6.8.0-134-generic kernel; a distribution
or hosted-runner label alone does not establish hook compatibility. Mandatory
hook attachment, quiescence, counters and authenticated cleanup must succeed on
the actual running kernel. A successful build receipt is not scenario proof.

Both central Cloud stability jobs install this authority and pass its path to
the exact-three lane. Each execution step allows three 600-second attempts with
up to 600 seconds of cancellation cleanup apiece, plus a 1,440-second native
preflight and outer authority/report boundary. The native preflight itself runs
the same guardian-backed allocation and full
identity inspection, allowing 600 seconds of work and 600 seconds of cancellation
cleanup plus process-control grace. It runs once in the CLI, without a duplicate
workflow probe. The job also has explicit checkout, setup, native build,
containment-test and artifact-upload windows; these limits do not change
the report's selected per-attempt success budget.

The serial containment step allows 128 minutes: four lifecycle/capability controls
at 1,290 seconds each, a 1,980-second restricted-guardian control including
separate full-authority recovery, the 65-second descriptor control, fifteen FIFO
controls at 20 seconds each, and 175 seconds for parsers, admission and startup. Its unsigned kernel fixtures
never stand in for authenticated native scenario acceptance. The full job bound
is 252 minutes including the 84-minute exact-three lane and setup/artifacts.
These are worst-case cancellation bounds, not measured execution times.
