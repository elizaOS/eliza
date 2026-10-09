# Protected production-operations runners

This Terraform root reserves two independent GitHub Actions runner hosts in the existing production Hetzner project.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test isolated database backup/recovery from the repository root (requires PostgreSQL 16 and pgBackRest):

```bash
bun run --cwd packages/cloud/infra test:pitr
```
