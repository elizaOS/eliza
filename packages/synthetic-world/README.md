# `@elizaos/synthetic-world`

SW-1 provides a durable SQLite command journal bound to the existing synthetic
environment lease generation. Callers supply the lease store and execute domain
mutations on the guarded SQLite transaction.

The package currently proves local command ownership, success and failure
replay, fencing, rollback-aware crash classification, and restart recovery.
Production boot, full manifests, virtual
clocks, fault injection, observation ledgers, and a Cloud journal adapter remain
unavailable and are reported as such by `SYNTHETIC_WORLD_CAPABILITIES`.
