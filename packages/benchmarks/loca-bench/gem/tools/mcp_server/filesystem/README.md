# Filesystem MCP Server

This module provides integration with the [@modelcontextprotocol/server-filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) MCP server.

## Features

The Filesystem server provides file and directory operations within a specified allowed directory:

- **read_file**: Read contents of a file
- **read_multiple_files**: Read multiple files at once
- **write_file**: Write content to a file
- **create_directory**: Create a new directory
- **list_directory**: List contents of a directory
- **move_file**: Move or rename a file
- **search_files**: Search for files by name or pattern
- **get_file_info**: Get metadata about a file

## Usage

### Single Server

```python
from gem.tools.mcp_server.filesystem import create_filesystem_tool

# Create filesystem tool for a specific directory
tool = create_filesystem_tool(allowed_directory="./workspace")

# Get available tools
tools = tool.get_available_tools()

# Execute file operations
action = '<tool_call><tool_name>read_file</tool_name><parameters>{"path": "data.txt"}</parameters></tool_call>'
is_valid, has_error, obs, parsed = tool.execute_action(action)
```

### Multi-Server Configuration

```python
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.filesystem.helper import get_filesystem_stdio_config
from gem.tools.mcp_server.python_execute.helper import get_python_execute_stdio_config

# Get individual server configs
filesystem_config = get_filesystem_stdio_config(allowed_directory="./workspace")
python_config = get_python_execute_stdio_config(workspace_path="./workspace")

# Merge configs
merged_config = {
    "mcpServers": {
        **filesystem_config,
        **python_config
    }
}

# Create combined tool
tool = MCPTool(merged_config, validate_on_init=False)
```

## Parameters

### `allowed_directory` (Optional[str])
- The directory path that the filesystem server can access
- All file operations will be restricted to this directory and its subdirectories
- Default: current directory (`.`)

### `workspace_path` (Optional[str])
- Alias for `allowed_directory` (for consistency with other servers)

### `server_name` (str)
- Custom name for the server in multi-server configurations
- Default: `"filesystem"`

## Security

⚠️ **Important**: The filesystem server can only access files within the specified `allowed_directory`. This is a security feature to prevent unauthorized file access.

## Requirements

The filesystem server requires `npx` and will automatically install the necessary package:
```bash
npx -y @modelcontextprotocol/server-filesystem
```

