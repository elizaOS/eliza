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
bun run --cwd packages/cloud/services/operator typecheck   # tsc --noEmit
bun run --cwd packages/cloud/services/operator lint         # biome check .
bun run --cwd packages/cloud/services/operator lint:fix     # biome check --write .
bun run --cwd packages/cloud/services/operator build        # node ./scripts/build.mjs (pepr build)
bun run --cwd packages/cloud/services/operator dev          # bunx pepr dev (needs a cluster)
bun run --cwd packages/cloud/services/operator test         # bun test — capabilities/__tests__; also swept by the PR-lane `bun run test:cloud`
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

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [CLAUDE.md](../../../../CLAUDE.md).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
