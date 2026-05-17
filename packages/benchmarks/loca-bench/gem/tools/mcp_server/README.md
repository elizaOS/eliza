# GEM MCP Servers

Collection of Model Context Protocol (MCP) servers integrated with the GEM framework.

## Available Servers

### 1. Canvas MCP Server
**Location:** `canvas/`  
**Type:** FastMCP 2.0 implementation  
**Description:** Complete Canvas LMS integration with 67 tools for managing courses, assignments, submissions, quizzes, discussions, and more.

**Quick Start:**
```python
from gem.tools.mcp_tool import MCPTool

# Start the Canvas server
tool = MCPTool("http://127.0.0.1:8082/canvas-mcp")

# Or from a different directory
tool = MCPTool.from_config_file(
    "gem/tools/mcp_server/canvas/config.json"
)
```

**Documentation:**
- [README.md](canvas/README.md) - Full documentation
- [QUICKSTART.md](canvas/QUICKSTART.md) - Quick start guide

### 2. Time MCP Server
**Location:** `time_mcp.py`  
**Type:** FastMCP 2.0 implementation  
**Description:** Time and date utilities with timezone support.

**Quick Start:**
```python
from gem.tools.mcp_tool import MCPTool

tool = MCPTool("http://127.0.0.1:8000/time-mcp")
```

### 3. Memory MCP Server (Knowledge Graph)
**Location:** `memory/`  
**Type:** Stdio (npx-based)  
**Description:** Knowledge graph-based memory system for storing and retrieving entities, relations, and observations across conversations.

**Quick Start:**
```python
from gem.tools.mcp_server.memory import create_memory_tool

# Create with default settings
tool = create_memory_tool()

# Or specify custom memory file
tool = create_memory_tool(
    memory_file_path="/path/to/memory.json"
)
```

**Documentation:**
- [README.md](memory/README.md) - Full documentation
- [QUICKSTART.md](memory/QUICKSTART.md) - Quick start guide
- [example.py](memory/example.py) - Complete usage example

### 4. WooCommerce MCP Server
**Location:** `woocommerce/`  
**Type:** Stdio (uv/python-based)  
**Description:** WooCommerce REST API integration with 50+ tools for managing products, orders, customers, coupons, and more using local JSON database.

**Quick Start:**
```python
from gem.tools.mcp_server.woocommerce import create_woocommerce_tool_stdio

# Auto-starts server (stdio mode)
tool = create_woocommerce_tool_stdio(
    data_dir="./woocommerce_data",
    validate_on_init=False
)

# Or HTTP mode (requires manual server startup)
from gem.tools.mcp_server.woocommerce import create_woocommerce_tool_http
tool = create_woocommerce_tool_http(validate_on_init=False)
```

**Documentation:**
- [README.md](woocommerce/README.md) - Full documentation
- [example.py](woocommerce/example.py) - Complete usage example

### 5. Google Cloud MCP Server
**Location:** `google_cloud/`  
**Type:** Stdio (uv/python-based)  
**Description:** Google Cloud Platform integration with BigQuery, Cloud Storage, Compute Engine, and IAM using local database.

**Quick Start:**
```python
from gem.tools.mcp_server.google_cloud import create_google_cloud_tool_stdio

tool = create_google_cloud_tool_stdio(
    data_dir="./google_cloud_data",
    validate_on_init=False
)
```

**Documentation:**
- [README.md](google_cloud/README.md) - Full documentation
- [example.py](google_cloud/example.py) - Complete usage example

### 6. Email MCP Server
**Location:** `emails/`  
**Type:** Stdio (python-based)  
**Description:** Email management system integration for managing emails, folders, and drafts using local JSON database.

**Quick Start:**
```python
from gem.tools.mcp_server.emails import create_email_tool_stdio

tool = create_email_tool_stdio(
    data_dir="./email_data",
    email="user@example.com",
    password="password",
    validate_on_init=False
)
```

**Documentation:**
- [README.md](emails/README.md) - Full documentation
- [example.py](emails/example.py) - Complete usage example

## MCP Server Types

### HTTP/Streamable-HTTP Servers
These servers run as standalone HTTP services:
- **Canvas** - Runs on port 8082 (default)
- **Time** - Runs on port 8000 (default)

Start them manually before use:
```bash
cd gem/tools/mcp_server/canvas
python server.py --transport streamable-http --port 8082
```

### Stdio Servers
These servers are spawned automatically via command execution:
- **Memory** - Runs via `npx @modelcontextprotocol/server-memory`
- **WooCommerce** - Runs via `uv run python server.py` from mcp_convert
- **Google Cloud** - Runs via `uv run python server.py` from mcp_convert
- **Email** - Runs via `python server.py` from mcp_convert

No manual server startup needed - the MCPTool handles it automatically.

## Using MCP Servers with GEM

### Basic Usage

```python
from gem.tools.mcp_tool import MCPTool

# For HTTP servers (Canvas, Time)
tool = MCPTool("http://localhost:8082/canvas-mcp")

# For stdio servers (Memory)
from gem.tools.mcp_server.memory import create_memory_tool
tool = create_memory_tool()

# Get available tools
tools = tool.get_available_tools()
for t in tools:
    print(f"{t['name']}: {t['description']}")

# Execute actions
action = '''
<tool_call>
<tool_name>tool_name</tool_name>
<arguments>
{"param": "value"}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action)
```

### Integration with GEM Environments

```python
import gem
from gem.tools.mcp_tool import MCPTool
from gem.tools.tool_env_wrapper import ToolEnvWrapper

# Create environment
env = gem.make("math:GSM8K")

# Create MCP tools
canvas_tool = MCPTool("http://localhost:8082/canvas-mcp")
memory_tool = create_memory_tool()

# Wrap environment with multiple tools
wrapped_env = ToolEnvWrapper(env, tools=[canvas_tool, memory_tool])

# Use normally
obs, info = wrapped_env.reset()
```

### Multi-Server Configuration

**Full Guide:** See [MULTI_SERVER_GUIDE.md](MULTI_SERVER_GUIDE.md) for detailed tutorials and examples.

**Quick Start:**
```python
from gem.tools.mcp_server import create_multi_server_tool

# Use both Canvas and Memory with a single line of code!
tool = create_multi_server_tool(validate_on_init=False)
```

**Full Configuration:**
```python
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.woocommerce import get_woocommerce_stdio_config
from gem.tools.mcp_server.google_cloud import get_google_cloud_stdio_config
from gem.tools.mcp_server.emails import get_email_stdio_config

# Get stdio server configs
woocommerce_config = get_woocommerce_stdio_config(data_dir="./woocommerce_data")
gcloud_config = get_google_cloud_stdio_config(data_dir="./google_cloud_data")
email_config = get_email_stdio_config(data_dir="./email_data")

# Configure multiple servers
config = {
    "mcpServers": {
        "canvas": {
            "transport": "http",
            "url": "http://localhost:8082/canvas-mcp"
        },
        "time": {
            "transport": "http",
            "url": "http://localhost:8000/time-mcp"
        },
        "memory": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory"],
            "env": {
                "MEMORY_FILE_PATH": "./memory.json"
            }
        },
        **woocommerce_config,  # WooCommerce stdio server
        **gcloud_config,       # Google Cloud stdio server
        **email_config,        # Email stdio server
    }
}

# Create tool with all servers
tool = MCPTool(config)

# Tools from all servers are available
# Canvas tools: canvas_list_courses, canvas_get_assignment, etc.
# Time tools: time_current_time, time_days_in_month, etc.
# Memory tools: memory_create_entities, memory_search_nodes, etc.
# WooCommerce tools: woo_products_list, woo_orders_get, etc.
# Google Cloud tools: bigquery_list_datasets, storage_list_buckets, etc.
# Email tools: get_current_user, list_emails, etc.
```

## Directory Structure

```
mcp_server/
├── README.md                    # This file
├── time_mcp.py                 # Time server implementation
├── canvas/                     # Canvas LMS server
│   ├── server.py              # Main server implementation
│   ├── database.py            # Database utilities
│   ├── data/                  # Canvas data files (JSON)
│   ├── README.md              # Documentation
│   ├── QUICKSTART.md          # Quick start guide
│   └── test_canvas_server.py  # Test script
├── memory/                     # Memory/Knowledge Graph server
│   ├── __init__.py            # Package initialization
│   ├── helper.py              # Helper functions
│   ├── config.json            # Default configuration
│   ├── README.md              # Documentation
│   ├── QUICKSTART.md          # Quick start guide
│   ├── example.py             # Usage example
│   └── test_memory_tool.py    # Test script
├── woocommerce/               # WooCommerce server
│   ├── __init__.py            # Package initialization
│   ├── helper.py              # Helper functions
│   ├── README.md              # Documentation
│   └── example.py             # Usage example
├── google_cloud/              # Google Cloud Platform server
│   ├── __init__.py            # Package initialization
│   ├── helper.py              # Helper functions
│   ├── README.md              # Documentation
│   └── example.py             # Usage example
└── emails/                    # Email management server
    ├── __init__.py            # Package initialization
    ├── helper.py              # Helper functions
    ├── README.md              # Documentation
    └── example.py             # Usage example
```

## Creating New MCP Servers

### Option 1: FastMCP Implementation (Recommended)

For complex servers with many tools, use FastMCP:

```python
from fastmcp import FastMCP

app = FastMCP("My Server")

@app.tool()
def my_tool(param: str) -> str:
    """Tool description."""
    return f"Result: {param}"

if __name__ == "__main__":
    app.run()
```

See `canvas/server.py` or `time_mcp.py` for full examples.

### Option 2: External Server Configuration

For existing MCP servers (npm packages, other languages):

```python
# Just create a helper function
def create_my_tool(config_param: str) -> MCPTool:
    config = {
        "mcpServers": {
            "myserver": {
                "command": "command_to_run",
                "args": ["arg1", "arg2"],
                "env": {"CONFIG": config_param}
            }
        }
    }
    return MCPTool(config)
```

See `memory/helper.py` for an example.

## Testing MCP Servers

Each server should include test scripts:

```python
# Test Canvas server
cd canvas
python test_canvas_server.py

# Test Memory server
cd memory
python test_memory_tool.py

# Run examples
cd memory
python example.py
```

## Resources

- [FastMCP Documentation](https://gofastmcp.com)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- [GEM Framework](https://github.com/axon-rl/gem)

## Contributing

To add a new MCP server:

1. Create a new directory: `mcp_server/myserver/`
2. Implement the server (FastMCP or external)
3. Add helper functions if needed
4. Create documentation (README.md, QUICKSTART.md)
5. Add test scripts
6. Update this README.md

## Troubleshooting

### Connection Issues
- Ensure HTTP servers are running before connecting
- Check firewall settings for HTTP servers
- Verify port numbers in configuration

### Stdio Server Issues
- Ensure required runtime is installed (Node.js for npx)
- Check command paths and arguments
- Review environment variables

### Tool Discovery Issues
- Wait for server initialization
- Check server logs for errors
- Increase `execution_timeout` parameter

For server-specific issues, see the individual README files in each server directory.
