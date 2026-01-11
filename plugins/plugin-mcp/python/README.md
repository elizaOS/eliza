# elizaOS MCP Plugin (Python)

A Python implementation of the Model Context Protocol (MCP) client for elizaOS agents.

## Installation

```bash
pip install elizaos-plugin-mcp
```

## Features

- **Stdio Transport**: Connect to MCP servers via stdio (subprocess)
- **HTTP/SSE Transport**: Connect to MCP servers via HTTP/SSE
- **Tool Calling**: Execute tools from connected MCP servers
- **Resource Reading**: Read resources from MCP servers
- **Strong Typing**: Full type hints with Pydantic models
- **Fail-Fast Validation**: Strict validation with no error swallowing

## Usage

```python
import asyncio
from elizaos_plugin_mcp import McpClient, StdioTransport, StdioServerConfig

async def main():
    # Create a stdio transport config
    config = StdioServerConfig(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-memory"]
    )

    async with StdioTransport(config) as transport:
        client = McpClient(transport)
        await client.connect()

        # List available tools
        tools = await client.list_tools()
        for tool in tools:
            print(f"Tool: {tool.name} - {tool.description}")

        # Call a tool
        result = await client.call_tool(
            name="store_memory",
            arguments={"key": "greeting", "value": "Hello, World!"}
        )
        print(f"Result: {result}")

asyncio.run(main())
```

## Configuration

### Stdio Transport

```python
from elizaos_plugin_mcp import StdioServerConfig

config = StdioServerConfig(
    command="npx",
    args=["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
    env={"NODE_ENV": "production"},
    cwd="/working/dir",
    timeout_ms=60000
)
```

### HTTP/SSE Transport

```python
from elizaos_plugin_mcp import HttpServerConfig

config = HttpServerConfig(
    url="https://mcp-server.example.com/sse",
    timeout_ms=30000
)
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_mcp

# Linting
ruff check .
ruff format .
```

## License

MIT License - see LICENSE file for details.
