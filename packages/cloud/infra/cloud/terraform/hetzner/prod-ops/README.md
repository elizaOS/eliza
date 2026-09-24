# Protected production-operations runners

This Terraform root reserves two independent GitHub Actions runner hosts in the existing production Hetzner project.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test from the repository root:

```bash
bun run --cwd packages/cloud/infra test
```
