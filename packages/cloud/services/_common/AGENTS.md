# @elizaos/cloud-services-common

Shared, dependency-free TypeScript utilities for the `packages/cloud/services/*`
packages: a structured JSON logger factory and Kubernetes ServiceAccount
credential helpers. Private (unpublished), ESM, sources consumed directly from
`src/` (no build step — `main`/`types` point at `src/index.ts`).

## Layout / exports

- `src/index.ts` — barrel; re-exports everything below.
- `src/logger.ts` (`./logger`) — `createServiceLogger(serviceName, options?)`
  returns a `ServiceLogger` (`debug`/`info`/`warn`/`error`/`shouldLog`) that
  emits one JSON object per line. Level is gated by the `LOG_LEVEL` env var
  (`debug | info | warn | error`, default `info`), re-read on every call. Field
  order is selectable via `ServiceLoggerOptions.metaFirst`: default
  `{ timestamp, level, message, ...meta }`; `metaFirst: true` yields the
  agent-server shape `{ ...meta, timestamp, level, message }`.
- `src/k8s-service-account.ts` (`./k8s-service-account`) —
  `readServiceAccountToken()` and `readServiceAccountCaCert()` read the
  projected pod credentials under
  `/var/run/secrets/kubernetes.io/serviceaccount/`. Both return `null` when the
  files are absent (e.g. a developer laptop outside a cluster) and cache the
  first result. `__resetServiceAccountCacheForTests()` clears that cache for
  tests only.

## Key scripts

Scope to this package with `--cwd packages/cloud/services/_common`:

```bash
bun run --cwd packages/cloud/services/_common typecheck   # tsgo --noEmit
bun run --cwd packages/cloud/services/_common lint         # biome check .
bun run --cwd packages/cloud/services/_common lint:fix     # biome check --write .
bun run --cwd packages/cloud/services/_common test         # placeholder: prints "no tests"
```

## Conventions / gotchas

- The log output format is consumed by production log parsers — do not change
  the field set or ordering. Add structured context via the `meta` argument.
- `serviceName` is accepted by `createServiceLogger` for call-site convention
  but is not currently written into the log line.
- The k8s helpers cache on first successful read; in tests that toggle the
  cluster files, call `__resetServiceAccountCacheForTests()` between cases.
- This is the one place in cloud-services where `console.*` is intentional —
  it is the logger sink itself. Other cloud-services code should log through
  `createServiceLogger`, not `console`.
- No runtime dependencies; keep it that way so every service can import it
  cheaply.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../../../AGENTS.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../../AGENTS.md)**. Read it.
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
