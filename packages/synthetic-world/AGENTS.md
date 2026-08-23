# Synthetic world command authority

This package owns the durable, generation-fenced command journal used by
synthetic-environment control callers. It composes over the shared lease store;
it does not own leases, domain state, an HTTP control plane, or a simulator.

## Invariants

- Every command write runs through `withActiveGeneration` on the supplied lease
  store and uses its transaction context.
- A command ID is unique for a namespace across generations. Reuse requires the
  same command type and canonical payload hash.
- A rolled-back `EXECUTING` mutation is `FAILED` with `KNOWN_FAILURE`. Only a
  `COMMITTED` mutation whose response was lost becomes `DIRTY`/`UNKNOWN`.
- Domain mutations are synchronous and use the supplied SQLite transaction so
  their commit is atomic with the journal's `COMMITTED` checkpoint.
- Capability reporting must list unavailable surfaces explicitly. This package
  does not claim production boot, manifests, virtual time, fault injection,
  observation ledgers, or a Cloud adapter.

## Verification

Run `bun run --cwd packages/synthetic-world test`, `typecheck`, `lint:check`,
and `build`. Process-crash tests are required for transaction rollback and
commit-before-response recovery.
