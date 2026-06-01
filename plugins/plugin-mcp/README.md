# @elizaos/plugin-mcp

elizaOS plugin that connects an Eliza agent to external [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers and exposes their tools and resources as agent capabilities.

The plugin starts `McpService`, which connects to one or more MCP servers (stdio, SSE, or streamable-HTTP), discovers their tools and resources, and surfaces them through a single `MCP` action and an `MCP` provider. It is consumed by an elizaOS agent: add it to the character `plugins` array and configure servers under `settings.mcp.servers`.

Node-only. `index.browser.ts` is a no-op shim because the MCP SDK's stdio/SSE transports require Node APIs (`eliza.platforms` is `["node"]`).

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

Config lives entirely in `settings.mcp`, not in environment variables. The host `PATH` is forwarded to stdio child processes automatically. Every server config is validated by `@elizaos/agent` (`validateMcpServerConfig`) before connect/spawn; configs that fail validation are skipped and logged at error level.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `mcp.servers` | `Record<string, McpServerConfig>` | — | Map of server name → transport config |
| `mcp.maxRetries` | `number` | `2` | Max reconnect attempts per server |

Transport config (see `src/types.ts`):

- **stdio** — `{ type: "stdio", command, args?, env?, cwd?, timeoutInMillis? }`
- **HTTP/SSE** — `{ type: "streamable-http" | "http" | "sse", url, timeout? }`

## Plugin surface

- **Action `MCP`** — single entry point for all MCP operations. `action=call_tool` invokes a server tool, `action=read_resource` reads a server resource (`search_actions` / `list_connections` are cloud-runtime-only). Similes include `CALL_MCP_TOOL`, `READ_MCP_RESOURCE`, `USE_TOOL`.
- **Provider `MCP`** — injects a summary of connected servers, their status, tools, and resources into agent context.
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

MCP servers can execute arbitrary code, so only connect to servers you trust. Spawn/connect of every configured server is gated on `validateMcpServerConfig`.

## License

MIT.
