# Cloudflare public-domain ownership

This Terraform root owns the durable browser, redirect-ingress, wildcard DNS, Railway tunnel DNS, and advanced-certificate assets for the consolidated `eliza-app` deployment.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test isolated database backup/recovery from the repository root (requires PostgreSQL 16 and pgBackRest):

```bash
bun run --cwd packages/cloud/infra test:pitr
```
