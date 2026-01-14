# elizaos-plugin-computeruse (Python)

Python plugin wrapper for ComputerUse.

- Local mode (Windows, macOS, Linux): uses the `computeruse` Python extension module (from `computeruse-py`). macOS requires Accessibility permissions; Linux requires AT-SPI2.
- MCP mode: spawns an MCP server via stdio (default: `npx -y computeruse-mcp-agent@latest`).

## Actions / arguments

- `COMPUTERUSE_CLICK`: requires `selector` and (in MCP mode) a `process` scope. You can pass `process` explicitly or prefix the selector with `process:<name> >> ...`.
- `COMPUTERUSE_TYPE`: same scoping rules as click.
- `COMPUTERUSE_GET_WINDOW_TREE`: requires `process` (and optional `title`, `maxDepth`).

