# `@elizaos/synthetic-world`

This package provides a storage-neutral durable command journal bound to the
existing synthetic environment lease generation. Callers supply a lease store
and journal repository, then execute synchronous or asynchronous domain
mutations on the guarded transaction context. The SQLite compatibility adapter
remains available for local use.

SW-2 adds a production-derived controller that durably claims one boot attempt,
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

Full manifests, virtual clocks, fault injection, observation ledgers,
deployment qualification, and atomic commands spanning the controller's local
SQLite journal and separate production PGlite repository remain unavailable
and are reported as such by `SYNTHETIC_WORLD_CAPABILITIES`.
