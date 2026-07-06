# @elizaos/operator — elizaOS Server Operator

A [Pepr](https://pepr.dev) Kubernetes operator that manages `Server`
(`servers.eliza.ai`, `v1alpha1`) custom resources in the `eliza-agents`
namespace. For each `Server` CR it reconciles the backing `Deployment`,
headless `Service`, and KEDA `ScaledObject` (scale-to-zero autoscaling), keeps
agent/server routing state in Redis, and patches CR status as pods come and go.

## Layout / entrypoints

- `pepr.ts` — module entrypoint; instantiates `PeprModule` with `package.json`
  config and the single `ServerController` capability.
- `capabilities/index.ts` — exports `ServerController`; wires the admission
  hooks: `Validate` on create/update, `Reconcile` + `Finalize` on the `Server`
  CR, status `Watch` on managed `Deployment`s, and self-healing `Watch`es that
  re-apply `Deployment`/`Service` if deleted externally (skipped when the CR is
  itself being deleted). Managed objects carry the `eliza.ai/managed-by=server-operator`
  and `eliza.ai/server=<name>` labels.
- `capabilities/reconciler.ts` — `reconciler` (idempotent via
  `observedGeneration`/`generation`; applies resources, writes Redis routing,
  reconciles agent-mapping diffs via the `eliza.ai/previous-agents` annotation),
  `finalizer` (Redis cleanup on delete), and `patchServerStatus`.
- `capabilities/controller/generators.ts` — `applyResources` plus the
  `Deployment` / headless `Service` / KEDA `ScaledObject` generators (owner
  references, labels, env wiring, Redis-list + CPU scale triggers).
- `capabilities/crd/` — `source/server.crd.ts` (the CRD definition),
  `register.ts` (applies the CRD on load), `validator.ts` (capacity bounds,
  agents ≤ capacity, no duplicate `agentId`), and `generated/server-v1alpha1.ts`
  (generated `Server` types — `ServerPhase`, etc.).
- `capabilities/redis.ts` — `ioredis` client and routing helpers
  (`setServerState`, `setAgentServer`, `removeAgentServer`, `cleanupServer`).
- `crds/server-crd.yaml` — YAML CRD manifest. `scripts/` — `build.mjs`
  (cross-platform `pepr build` wrapper) and `npm` (a `npm root` shim for the
  Pepr CLI).

## Key scripts

Scope to this package with `--cwd packages/cloud/services/operator`:

```bash
bun run --cwd packages/cloud/services/operator typecheck   # tsgo --noEmit
bun run --cwd packages/cloud/services/operator lint         # biome check .
bun run --cwd packages/cloud/services/operator lint:fix     # biome check --write .
bun run --cwd packages/cloud/services/operator build        # node ./scripts/build.mjs (pepr build)
bun run --cwd packages/cloud/services/operator dev          # bunx pepr dev (needs a cluster)
bun test --cwd packages/cloud/services/operator             # capabilities/__tests__ (bun:test)
```

`deploy:local` runs `pepr build` (with `ELIZA_OPERATOR_SKIP_CRD_REGISTER=1`)
then `./scripts/deploy-local.sh` — the deploy script is environment-local and
not committed.

## Conventions / gotchas

- **Pepr/Kubernetes runtime, not the agent runtime.** This package depends on
  `pepr`, `kubernetes-fluent-client`, and `ioredis` — not `@elizaos/core`. It is
  a deployment artifact (container image) that runs in-cluster.
- **Use `Log` from `pepr`** for logging in capabilities, not the structured core
  logger and never `console`.
- **Tests use `bun:test`** (not Vitest) and set `MOCK_REDIS=1`.
- **Env vars:** `REDIS_URL` (default `redis://redis.eliza-infra.svc:6379`) and
  `REDIS_ADDRESS` for the client and KEDA trigger address; `MOCK_REDIS=1` opts
  into the in-memory `ioredis-mock` (explicit opt-in only — real Redis is used
  whenever unset); `ELIZA_OPERATOR_SKIP_CRD_REGISTER=1` skips applying the CRD on
  load (set during builds).
- **Build is POSIX-only.** `scripts/build.mjs` no-ops on win32 — the Pepr CLI is
  POSIX-only and the operator builds on Linux CI before the container push.
- The CRD is applied at module load via `capabilities/crd/register.ts`
  (`import "./crd/register"` in `index.ts`); generated CR types under
  `crd/generated/` should be regenerated rather than hand-edited.
- Reconciliation is generation-gated and idempotent; managed resources use owner
  references so deleting the `Server` CR cascades, and the finalizer clears Redis
  routing keys.

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
