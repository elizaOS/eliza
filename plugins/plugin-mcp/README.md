# @elizaos/plugin-mcp

elizaOS plugin that connects an Eliza agent to external [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers and exposes their tools and resources as agent capabilities.

The plugin starts `McpService`, which connects to configured MCP servers and surfaces them through an `MCP` provider plus promoted operation subactions. Product-managed connectors can instead import `@elizaos/plugin-mcp/resource-engine` for authenticated, stateless discovery and exact tool calls without exposing refresh tokens or routing through a second model selection.

Node-only. `index.browser.ts` is a browser-unavailable entry because the MCP SDK's stdio/SSE transports require Node APIs (`eliza.platforms` is `["node"]`).

## Install

```bash
bun add @elizaos/plugin-mcp   # or: npm install / yarn add
```

## Usage

Add the plugin and declare servers in your character file:

```json
{
  "name": "Your Character",
  "plugins": ["@elizaos/plugin-mcp"],
  "settings": {
    "mcp": {
      "servers": {
        "github": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>" }
        },
        "my-http-server": {
          "type": "streamable-http",
          "url": "https://example.com/mcp"
        }
      },
      "maxRetries": 2
    }
  }
}
```

Config lives entirely in `settings.mcp`, not in environment variables. The host `PATH` is forwarded to stdio child processes automatically. Malformed settings and rejected server configs fail service initialization instead of silently disabling or partially starting MCP. Every server config is validated by `@elizaos/core/security/mcp-server-config` (`validateMcpServerConfig`) before connect/spawn. Remote transports route every request through core's DNS-pinned SSRF guard, including redirects.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `mcp.servers` | `Record<string, McpServerConfig>` | — | Map of server name → transport config |
| `mcp.maxRetries` | `number` | `2` | Max model-selection retries for the legacy MCP action |

Transport config (see `src/types.ts`):

- **stdio** — `{ type: "stdio", command, args?, env?, cwd?, timeoutInMillis? }`
- **HTTP/SSE** — `{ type: "streamable-http" | "http" | "sse", url, timeout? }`

## Plugin surface

- **Actions `MCP`, `MCP_CALL_TOOL`, `MCP_READ_RESOURCE`, ...** — operation-level actions created by subaction promotion. They do not materialize one action per discovered tool.
- **Provider `MCP`** — injects a summary of connected servers, their status, tools, and resources into agent context.
- **Resource engine** — validates a remote endpoint, obtains short-lived access tokens from a callback, negotiates the modern MCP protocol, drains paginated discovery, and performs exact tool calls using a fresh operation-local client.
- **`handleMcpRoutes`** (exported) — HTTP handler for `/api/mcp/*` (config CRUD, marketplace search, runtime status), wired up by the host server, not by the plugin object. The `McpRouteContext` type is also exported.

## src layout

```
src/
  index.ts              Plugin object — registers McpService, MCP action, MCP provider
  types.ts              Shared types + config guards (McpSettings, McpServerConfig, …)
  service.ts            McpService — connection lifecycle, tool calls, resource reads, ping/reconnect
  provider.ts           MCP provider — connected-server summary for agent state
  routes-mcp.ts         handleMcpRoutes — /api/mcp/config, /api/mcp/status, marketplace
  mcp-marketplace.ts    Client for registry.modelcontextprotocol.io (search + details)
  prompts.ts            Handlebars-style prompt templates
  actions/mcp.ts        mcpAction handler — op routing
  templates/            Thin re-export shims over prompts.ts
  utils/                Selection, validation, processing, error, and JSON helpers
  tool-compatibility/   Per-provider tool-schema fixup (Anthropic/OpenAI/Google)
```

## Commands

```bash
bun run build         # bun run build.ts → dist/ (ESM + CJS + .d.ts)
bun run dev           # hot-rebuild with bun --hot
bun run test          # vitest run
bun run typecheck     # tsgo --noEmit
bun run lint          # biome check --write --unsafe
bun run format        # biome format --write
bun run clean         # rm -rf dist .turbo
```

## Security

MCP servers can execute arbitrary code, so only connect to servers you trust. Spawn/connect of every configured server is gated on `validateMcpServerConfig` from `@elizaos/core/security/mcp-server-config`; remote requests additionally use core's DNS-pinned SSRF transport.

## License

MIT.
