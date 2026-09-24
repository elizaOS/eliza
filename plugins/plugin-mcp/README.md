# @elizaos/plugin-mcp

elizaOS plugin that connects Eliza agents to external MCP (Model Context Protocol)
servers, exposing their tools and resources as agent capabilities.

Configure servers under `settings.mcp.servers` using the types in `src/types.ts`. Validate every server before connecting; remote requests use the core SSRF guard and stdio processes inherit only permitted environment values.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-mcp build  # build
bun run --cwd plugins/plugin-mcp test   # tests
```
