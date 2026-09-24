# @elizaos/cloud-e2e

Full-stack, mock-backed Playwright end-to-end suite for the cloud API and the Cloud
surfaces in `packages/app`.

Playwright exercises the cloud stack against stateful mocks. Install the repository
Playwright browsers first. These tests are mock-backed and do not prove live provider
behavior.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/e2e test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.
