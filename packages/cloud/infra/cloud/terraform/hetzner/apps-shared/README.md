# elizaOS Cloud Apps — environment database infrastructure

This root provisions one private network, PostgreSQL host, PGDATA volume, firewall and database credentials for **one** of development, staging or production.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test isolated database backup/recovery from the repository root (requires PostgreSQL 16 and pgBackRest):

```bash
bun run --cwd packages/cloud/infra test:pitr
```
