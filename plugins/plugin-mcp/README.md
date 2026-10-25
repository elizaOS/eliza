# @elizaos/plugin-mcp

elizaOS plugin that connects Eliza agents to external MCP (Model Context Protocol)
servers, exposing their tools and resources as agent capabilities.

Tool argument validation defaults to JSON Schema 2020-12. An explicit
`http://json-schema.org/draft-07/schema#` selects draft-07 instead. Unsupported
dialects are rejected within the existing isolated validation worker.
If an undeclared schema cannot compile as 2020-12, the same bounded worker
tries draft-07 to support legacy tuple schemas. A failed argument validation
never triggers this fallback. Declared schemas always use their stated dialect.

Argument-generation retries retain the selected tool, complete input schema,
conversation context and argument response format, with the latest validation
error and rejected response. Retries do not select another tool.

Discovery requests only the tools and resources that the server declares. Servers
that provide resources without tools can connect and serve agent context. Stdio
health checks use protocol `ping` with the configured timeout, not `tools/list`.

Tool results retain both `content` and `structuredContent`. The JSON result is
included in the response model's input, action output, and stored tool memory.
Text, image and audio attachments, and the tool's error status remain available.
Tool-generated audio is shared in the reply and saved with that reply.
If a text block parses as the same JSON data, it is used without adding a
second copy. Its whitespace, formatting, and key order are retained.
JSON embedded in prose remains ordinary text.

Tool resource links retain their URI and complete metadata in the result text.
Eliza does not read the linked resource until the agent requests a resource read.

Successful resource reads return the complete processed content in
`ActionResult.data.output`, so later planner steps can use the resource data.
The existing analysis response and resource memory remain available.

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
