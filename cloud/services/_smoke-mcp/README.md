# cloud-mcp-smoke

**Temporary smoke test. Not production. Delete once a verdict is written
to `cloud/api/MCP_WORKERS_VERIFICATION.md`.**

Purpose: isolate the `mcp-handler` + `@modelcontextprotocol/sdk` stack
from the rest of the cloud Worker so that a `wrangler deploy --dry-run`
reveals exactly whether MCP can run on Cloudflare Workers (workerd
runtime + `nodejs_compat`). 20 cloud routes are blocked on this answer
(`cloud/api/mcp/route.ts`, `cloud/api/agents/[id]/mcp/route.ts`, and 18
per-service `cloud/api/mcps/*/[transport]/route.ts` files).

## Why a separate harness?

The main cloud Worker has many other deps that may or may not build on
Workers. Bundling MCP routes into that Worker means a build failure
could be from anything. This harness has only `hono`, `mcp-handler`,
`@modelcontextprotocol/sdk`, and `zod`. If `wrangler deploy --dry-run`
fails here, the failure is unambiguously MCP-related.

## Usage

```bash
cd cloud/api/_smoke-mcp
bun install
bun run dry-deploy   # wrangler deploy --dry-run --outdir=dist
# optional, only if dry-deploy succeeds:
bun run dev          # wrangler dev --port 8788
curl -X POST http://localhost:8788/mcps/time/streamable-http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Cleanup

This whole directory can be deleted once `MCP_WORKERS_VERIFICATION.md`
records the verdict and the 20 stubbed MCP routes are either unblocked
or rerouted to a fallback (e.g. Node sidecar).
