# @elizaos/cloud-sdk

TypeScript SDK for the Eliza Cloud API: auth, agent management, inference, billing,
containers, and typed public-route access.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/sdk build  # build
bun run --cwd packages/cloud/sdk test:e2e  # live integration tests
```

Live tests use the configured Cloud endpoints. Set `ELIZAOS_CLOUD_API_KEY` for authenticated API checks and `ELIZA_CLOUD_SESSION_TOKEN` for session checks; tests without their credentials skip. Write/generation/container checks require separate explicit opt-in flags in `src/live.e2e.test.ts`.
