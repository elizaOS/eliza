# Synthetic world command authority

This package owns the storage-neutral, durable, generation-fenced command journal and production-derived runtime controller used by synthetic-environment control callers.

Fence every command write by the active lease generation and transaction. Preserve idempotent replay and reject stale generations.

Build, test, and setup: [README.md](README.md).
