# @elizaos/cloud-routing

Shared routing resolver that decides whether a service call should use a locally
configured API key, be proxied through Eliza Cloud, or be disabled.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/routing build  # build
bun run --cwd packages/cloud/routing test   # tests
```
