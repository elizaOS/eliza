# cloud-mcp-smoke

Isolated Cloudflare Workers compatibility harness for `mcp-handler` and the Model Context Protocol SDK.

## Role

This private package answers one narrow question: can the MCP transport stack bundle and run under workerd with `nodejs_compat`? It is diagnostic infrastructure, not a production service, application route owner, or reusable MCP abstraction.

Keep dependencies minimal so a dry-deploy failure remains attributable to the MCP stack. Production MCP routes and policy belong in `packages/cloud/api`.

## Files

```
worker.ts       minimal Hono/MCP Worker
wrangler.toml   workerd and compatibility configuration
package.json    isolated dependency and script surface
README.md       manual request example
```

## Commands

```bash
bun run --cwd packages/cloud/services/_smoke-mcp dry-deploy
bun run --cwd packages/cloud/services/_smoke-mcp dev
```

Use `dev` only after `dry-deploy` bundles successfully. Exercise the streamable-HTTP endpoint with a real JSON-RPC `tools/list` request.

## Change rules

- Do not import the production cloud Worker or its broad dependency graph.
- Keep the harness private and side-effect-free outside its Wrangler dev process.
- Record a durable compatibility verdict in the owning cloud API documentation or tests before removing or changing the harness.
- A successful dry deploy proves bundling only; runtime claims require a real workerd request and inspected response/logs.
- Fail explicitly on protocol or runtime incompatibility. Do not replace an unsupported route with an empty tool list.

## Verification

Follow the [cloud guide](../../CLAUDE.md) and repository-wide standard in the [root CLAUDE.md](../../../../CLAUDE.md). Inspect the Wrangler bundle result, run the local Worker, send a real MCP request, and review the response and Worker logs.
