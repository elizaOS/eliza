# @elizaos/cloud-services-common

Shared, import-light TypeScript utilities for Cloudflare Workers and the `packages/cloud/services/*` sidecars: connector protocol, retry, delivery, structured logging, and Kubernetes ServiceAccount helpers.


Use `/transport` for Worker-safe fetch, retry and wire contracts, `/node` for
Kubernetes and Node service helpers, and `/testing` for test-only controls.

Install workspace dependencies with `bun install` at the repository root.

No separate build script; this workspace runs from source.

Test from the repository root:

```bash
bun run --cwd packages/cloud/services/_common test
```
