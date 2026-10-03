# Operator E2E Tests (Chainsaw)

End-to-end tests for the Eliza Server Operator using [Chainsaw](https://kyverno.github.io/chainsaw/) (Kyverno).

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test isolated database backup/recovery from the repository root (requires PostgreSQL 16 and pgBackRest):

```bash
bun run --cwd packages/cloud/infra test:pitr
```
