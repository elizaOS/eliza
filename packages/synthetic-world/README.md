# `@elizaos/synthetic-world`

This package provides a durable SQLite command journal bound to the existing synthetic
environment lease generation. Callers supply the lease store and execute domain
mutations on the guarded SQLite transaction.

SW-2 adds a production-derived controller that durably claims one boot attempt,
boots the canonical `@elizaos/agent` runtime against an explicit PGlite path,
and reads the persisted agent entity back through the production repository.
Its proof records the sorted plugin names observed on `runtime.plugins` and the
exact public PGlite configuration. The result distinguishes a genuinely
unavailable local runtime from typed input, claim, initialization, proof, and
teardown failures. The controller owns idempotent typed runtime teardown.

The package proves local command ownership, success and failure
replay, fencing, rollback-aware crash classification, and restart recovery.
Full manifests, virtual clocks, fault injection, observation ledgers, a Cloud
journal adapter, deployment qualification, and atomic commands spanning the
SQLite journal and production PGlite domain repository remain unavailable and
are reported as such by `SYNTHETIC_WORLD_CAPABILITIES`.
