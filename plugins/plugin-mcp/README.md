# @elizaos/plugin-mcp

elizaOS plugin that connects Eliza agents to external MCP (Model Context Protocol)
servers, exposing their tools and resources as agent capabilities.

Configure servers under `settings.mcp.servers` using `McpSettings` from `@elizaos/plugin-mcp`. Validate every server before connecting; remote requests use the core SSRF guard and stdio processes inherit only permitted environment values.

Discovery follows every tool, resource, and resource-template page before exposing
the connected server's capabilities. Empty intermediate pages are allowed;
repeated cursors or later-page failures surface as connection errors rather than
silently publishing a partial catalog.
Each list rejects more than 1,000 pages with `MCP_PAGINATION_LIMIT_EXCEEDED`;
this bounds endless discovery without publishing a truncated catalog. An empty
string cursor is opaque, so repeatedly returning it is a connection error.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-mcp build  # build
bun run --cwd plugins/plugin-mcp test   # tests
```
