# elizaOS Cloud Apps — environment worker infrastructure

This root provisions app Docker hosts, network attachments, firewalls and wildcard ingress for one environment.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test from the repository root:

```bash
bun run --cwd packages/cloud/infra test
```
