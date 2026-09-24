# elizaOS Cloud Apps — environment database infrastructure

This root provisions one private network, PostgreSQL host, PGDATA volume, firewall and database credentials for **one** of development, staging or production.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test from the repository root:

```bash
bun run --cwd packages/cloud/infra test
```
