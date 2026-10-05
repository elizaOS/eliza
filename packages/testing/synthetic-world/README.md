# `@elizaos/testing/synthetic-world`

This package provides a storage-neutral durable command journal bound to the
existing synthetic environment lease generation. Callers supply a lease store
and journal repository, then execute synchronous or asynchronous domain
mutations on the guarded transaction context. The SQLite compatibility adapter
remains available for local use.

The production controller durably claims one boot attempt,
boots the canonical `@elizaos/agent` runtime against an explicit PGlite path,
and reads the persisted agent entity back through the production repository.
Its proof records the sorted plugin names observed on `runtime.plugins` and the
exact public PGlite configuration. The result distinguishes a genuinely
unavailable local runtime from typed input, claim, initialization, proof, and
teardown failures. The controller owns idempotent typed runtime teardown.

The Cloud adapter uses the production Drizzle schema and lease transaction.
PGlite integration coverage proves an actual `AgentsRepository` mutation and
readback commit atomically with the journal's `COMMITTED` transition, plus
replay, conflict, fencing, rollback, ambiguous-response recovery, and corrupt
state handling. It does not claim genuine multi-process PostgreSQL contention.

Leased API worlds use `startSyntheticScenarioWorld` with a versioned manifest,
namespace, manifest ID and service domains. Each domain has an optional `seed`
array of HTTP `{ method, path, body }` requests. Only registered mock services are
accepted. Seeds run against the actual mock handlers; state and IDs are repeatable
within a manifest. The world exposes SDK endpoints, runtime settings, snapshots,
an ordered request ledger, counted faults and idempotent cleanup. Unmatched routes
and unused faults fail `assertComplete()`. Mutating mock admin routes are disabled.

`createSyntheticWorldControlAuthority` connects these worlds to the authenticated
control protocol and existing session/subprocess executor. SDK clients must use
the supplied endpoint or their existing client injection seam. This does not
provide a process-wide network sandbox. Local API mock state is ephemeral; the
durable command journal remains the boundary for transactional production writes.

Import SQLite lease and journal adapters from
`@elizaos/testing/synthetic-world/sqlite`. Virtual production time, deployment
qualification and atomic writes spanning separate stores remain unavailable.
