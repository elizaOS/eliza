# General runner-farm systemd assets

Systemd units and repair tooling for the Hetzner GitHub Actions runner farm. Preserve control-group teardown so each runner slot has exactly one listener.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test isolated database backup/recovery from the repository root (requires PostgreSQL 16 and pgBackRest):

```bash
bun run --cwd packages/cloud/infra test:pitr
```
