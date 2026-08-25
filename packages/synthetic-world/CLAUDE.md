# Synthetic world command authority

This package owns the durable, generation-fenced command journal and the
production-derived runtime controller used by synthetic-environment control
callers. It composes over the shared lease store and canonical agent runtime; it
does not own leases, domain state, an HTTP control plane, or a simulator.

## Invariants

- Every command write runs through `withActiveGeneration` on the supplied lease
  store and uses its transaction context.
- A command ID is unique for a namespace across generations. Reuse requires the
  same command type and canonical payload hash.
- A rolled-back `EXECUTING` mutation is `FAILED` with `KNOWN_FAILURE`. Only a
  `COMMITTED` mutation whose response was lost becomes `DIRTY`/`UNKNOWN`.
- Domain mutations are synchronous and use the supplied SQLite transaction so
  their commit is atomic with the journal's `COMMITTED` checkpoint.
- Production controller boot requires a fresh durable claim and an explicit
  absolute PGlite path. The claim grants one async boot attempt; replay never
  boots a second runtime.
- The controller verifies the production adapter and persisted agent entity,
  records sorted names from the actual runtime plugin list and its public
  production configuration, and owns idempotent typed teardown. It never
  introduces parallel WorldData.
- `unavailable` means production boot returned no local runtime. Invalid input,
  journal claim, initialization, repository proof, and teardown problems are
  `failed` with a stage and exact typed code.
- The adversarial production-module seam lives in `production-controller.ts`
  and is intentionally absent from the package barrel. The public path always
  loads canonical `@elizaos/agent/runtime` after the durable claim succeeds.
- The local journal SQLite transaction cannot atomically mutate the separate
  production PGlite repository. Report that capability unavailable until a
  shared Cloud transaction adapter exists.
- Capability reporting must list unavailable surfaces explicitly. This package
  does not claim manifests, virtual time, fault injection, observation ledgers,
  deployment qualification, or a Cloud adapter.

## Verification

Run `bun run --cwd packages/synthetic-world test`, `typecheck`, `lint:check`,
and `build`. Process-crash tests are required for transaction rollback and
commit-before-response recovery. Controller tests must boot the real agent
runtime, inspect its PGlite repository, and exercise lease/replay rejection.
