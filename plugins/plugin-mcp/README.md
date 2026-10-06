# @elizaos/plugin-mcp

elizaOS plugin that connects Eliza agents to external MCP (Model Context Protocol)
servers, exposing their tools and resources as agent capabilities.

Configure servers under `settings.mcp.servers` using `McpSettings` from `@elizaos/plugin-mcp`. Validate every server before connecting; remote requests use the core SSRF guard and stdio processes inherit only permitted environment values.

Discovery follows every tool, resource, and resource-template page before exposing
the connected server's capabilities. Empty intermediate pages are allowed;
repeated cursors or later-page failures surface as connection errors rather than
silently publishing a partial catalog.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-mcp build  # build
bun run --cwd plugins/plugin-mcp test   # tests
```
