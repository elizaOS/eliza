# @elizaos/cloud-api

The Eliza Cloud HTTP API: a Cloudflare Workers app (Hono router) that backs auth,
app/agent registration, inference routing, billing, MCP, A2A, domains, and container
deploys.

Runs on Cloudflare Workers with Hono. Start with `bun run --cwd packages/cloud/api dev`;
local bindings are derived from root .env/.env.local. Add routes in the file-based route
tree and run the package codegen script. The build script checks types; typecheck also
validates router and Worker bundling contracts.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/api build  # build
bun run --cwd packages/cloud/api test   # tests
```
