# @elizaos/cloud-services-common

Shared, import-light TypeScript utilities for Cloudflare Workers and the `packages/cloud/services/*` sidecars: connector protocol, retry, delivery, structured logging, and Kubernetes ServiceAccount helpers.


Install workspace dependencies with `bun install` at the repository root.

No separate build script; this workspace runs from source.

Test from the repository root:

```bash
bun run --cwd packages/cloud/services/_common test
```
