# @elizaos/plugin-mcp

elizaOS plugin that connects Eliza agents to external MCP (Model Context Protocol) servers, exposing their tools and resources as agent capabilities.

## Purpose / role

Adds MCP client support to any Eliza agent. At runtime the plugin starts `McpService`, which connects to one or more MCP servers (stdio, SSE, or streamable-HTTP), discovers their tools and resources, and makes them available via a unified `MCP` action and `MCP` provider. The plugin is opt-in — add it to the `plugins` array in the character file and configure servers under `settings.mcp.servers`.

## Plugin surface

| Kind | Name | What it does |
|---|---|---|
| Action | `MCP` | Single entry point for all MCP operations. Routes to `call_tool` (invoke a server tool), `read_resource` (fetch a server resource), or the cloud-only `search_actions`/`list_connections` ops. Similes include `CALL_MCP_TOOL`, `READ_MCP_RESOURCE`, `USE_TOOL`, etc. |
| Provider | `MCP` | Injects a text summary of connected servers, their status, tools, and resources into the agent context on every turn. Contexts: `connectors`, `settings`. |
| Service | `McpService` | Manages all MCP connections (connect, ping, reconnect, disconnect). Exposes `callTool`, `readResource`, `getServers`, `getProviderData`, `restartConnection`. Service type key: `"mcp"`. |
| Routes (exported helper) | `handleMcpRoutes` | HTTP route handler for `/api/mcp/*` — config CRUD, marketplace search, and runtime status. Consumed by the host server; not registered directly by the plugin object. |

The plugin also exports `McpRouteContext` (type) for host servers wiring up `handleMcpRoutes`.

## Layout

```
plugins/plugin-mcp/
  src/
    index.ts                  Plugin object — registers McpService, MCP action, MCP provider
    types.ts                  All shared types + config guards (McpSettings, McpServerConfig,
                                McpServer, McpConnection, PingConfig, ToolSelectionSchema, …)
    service.ts                McpService — connection lifecycle, tool calls, resource reads,
                                ping monitoring, reconnect backoff
    provider.ts               MCP provider — formats connected-server summary for agent state
    routes-mcp.ts             handleMcpRoutes — /api/mcp/config, /api/mcp/status, marketplace
    mcp-marketplace.ts        Client for registry.modelcontextprotocol.io (search + details)
    prompts.ts                errorAnalysisTemplate (Handlebars-style)
    actions/
      mcp.ts                  mcpAction handler — op routing (call_tool / read_resource)
    templates/
      toolSelectionTemplate.ts
      toolReasoningTemplate.ts
      resourceSelectionTemplate.ts
      resourceAnalysisTemplate.ts
      feedbackTemplate.ts
      errorAnalysisPrompt.ts
    utils/
      error.ts                handleMcpError — error-to-response helper
      handler.ts              handleNoToolAvailable
      json.ts                 JSON parse helpers
      mcp.ts                  buildMcpProviderData
      processing.ts           processToolResult, processResourceResult, handleToolResponse,
                                handleResourceAnalysis, sendInitialResponse
      schemas.ts              ToolSelectionName, ToolSelectionArgument, ResourceSelection
                                types + JSON Schema objects + type guards
      selection.ts            createToolSelectionName, createToolSelectionArgument
      validation.ts           validateResourceSelection, feedback prompt builders
      wrapper.ts              withModelRetry — retry loop for model-parsed selections
    tool-compatibility/
      base.ts                 McpToolCompatibility base class + detectModelProvider
      index.ts                Factory: createMcpToolCompatibilitySync (Anthropic/OpenAI/Google)
      providers/              Per-provider schema fixup implementations
  __tests__/
    mcp-config-security.test.ts   Config validation / security tests
    integration/                  Integration test suite
  index.browser.ts          No-op browser shim (MCP client is node-only)
```

## Commands

All scripts in `plugins/plugin-mcp/package.json`:

```bash
bun run --cwd plugins/plugin-mcp build        # tsdown build → dist/
bun run --cwd plugins/plugin-mcp dev          # hot-rebuild with bun --hot
bun run --cwd plugins/plugin-mcp test         # vitest run
bun run --cwd plugins/plugin-mcp typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-mcp lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-mcp lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-mcp format       # biome format --write
bun run --cwd plugins/plugin-mcp format:check # biome format (read-only)
bun run --cwd plugins/plugin-mcp clean        # rm -rf dist .turbo
```

## Config / env vars

All config is read from the character `settings` object (or runtime settings), not from environment variables directly. The `PATH` env var is forwarded to stdio child processes automatically.

| Key (in `settings`) | Type | Required | Description |
|---|---|---|---|
| `mcp.servers` | `Record<string, McpServerConfig>` | Yes (for any connectivity) | Map of server name → transport config |
| `mcp.maxRetries` | `number` | No (default `2`) | Max reconnect attempts per server |

Transport config shapes (see `src/types.ts`):

- **stdio**: `{ type: "stdio", command: string, args?, env?, cwd?, timeoutInMillis? }`
- **HTTP/SSE**: `{ type: "streamable-http"|"http"|"sse", url: string, timeout? }`

The `agentConfig.pluginParameters` in `package.json` declares `PATH` and `mcp` for auto-config tooling.

Security: every server config is validated by `@elizaos/agent/security/mcp-server-config` before connection is attempted. Unsafe or malformed configs are rejected with a log message.

## How to extend

**Add a new transport type:**
1. Extend `McpServerConfig` union in `src/types.ts` and add an `is*Config` guard.
2. Add a transport builder in `src/service.ts` mirroring `buildStdioClientTransport` / `buildHttpClientTransport`.
3. Branch in `initializeConnection`.

**Add a new MCP op (e.g., `list_prompts`):**
1. Add the op name to the `McpOp` union in `src/actions/mcp.ts`.
2. Add normalization in `normalizeOp` and text inference in `inferOpFromText`.
3. Implement a `handleListPrompts` function following the pattern of `handleCallTool`.
4. Branch in the `handler` function.
5. Add the op to `McpService` if it requires a new SDK call.

**Add a new provider-specific tool compatibility rule:**
1. Create a class in `src/tool-compatibility/providers/` extending `McpToolCompatibility`.
2. Register it in `src/tool-compatibility/index.ts` under `createMcpToolCompatibilitySync`.

**Add a new API route:**
Add a branch in `src/routes-mcp.ts` `handleMcpRoutes`. The host server passes a `McpRouteContext`; follow the existing `GET /api/mcp/config` pattern.

## Conventions / gotchas

- **Node-only.** `index.browser.ts` is a no-op shim. The MCP SDK's stdio and SSE transports require Node.js APIs. The `eliza.platforms` field in `package.json` is `["node"]`.
- **Service type key is lowercase `"mcp"`.** `McpService.serviceType = "mcp"`. The status route resolves the service by uppercase `"MCP"` for legacy compat — keep this in mind if you refactor.
- **Tool schema fixup runs synchronously.** `createMcpToolCompatibilitySync` uses `require()` internally; this is intentional (called during server listing, not at import time).
- **Ping monitoring is stdio-only.** HTTP/SSE transports do not use the ping interval; reconnect is handled by transport error/close events.
- **Config changes require a restart.** The service reads `settings.mcp` once at init. `restartConnection(name)` re-initializes a single server without full restart; adding/removing servers requires plugin reinit.
- **Security validation is blocking.** `validateMcpServerConfig` from `@elizaos/agent` runs before every connection and spawn. Servers that fail validation are silently skipped (logged at error level).
- **Marketplace is read-only.** `mcp-marketplace.ts` queries `https://registry.modelcontextprotocol.io` to browse and discover MCP servers; it does not install them.
- **`promoteSubactionsToActions`** is applied to `mcpAction` in `index.ts`, so any sub-action expansion follows the elizaOS core convention.
- For architecture rules, logger conventions, ESM requirements, and naming standards, see the root `AGENTS.md`.
