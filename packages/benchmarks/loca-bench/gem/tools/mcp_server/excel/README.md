# Excel MCP Server

Comprehensive Excel file manipulation system for reading, writing, formatting, and data analysis.

## Overview

This module provides easy access to the `excel-mcp-server` MCP server, which implements comprehensive Excel file manipulation capabilities including:

- Reading and writing Excel files
- Cell formatting and styling
- Sheet management
- Formula calculation
- Chart creation
- Data analysis operations

The Excel server communicates through stdio transport, making it easy to use without any manual server setup.

## Prerequisites

- Python with `uv` package manager
- `excel-mcp-server` package installed

### Installation

```bash
# Install excel-mcp-server via uv pip
uv pip install excel-mcp-server
```

## Usage

### Method 1: Using the Helper Function (Recommended)

```python
from gem.tools.mcp_server.excel import create_excel_tool

# Create tool with default settings
tool = create_excel_tool()

# Or with custom configuration
tool = create_excel_tool(
    validate_on_init=False,
    client_session_timeout_seconds=100
)

# Get available tools
tools = tool.get_available_tools()
for t in tools:
    print(f"{t['name']}: {t['description']}")

# Use in your application
instruction = tool.instruction_string()
print(instruction)
```

### Method 2: Using MCPTool Directly

```python
from gem.tools.mcp_tool import MCPTool

# Create configuration
config = {
    "mcpServers": {
        "excel": {
            "command": "excel-mcp-server",
            "args": ["stdio"]
        }
    }
}

# Create tool
tool = MCPTool(config, validate_on_init=False)
```

### Method 3: From Config File

```python
from gem.tools.mcp_server.excel import create_excel_tool_from_config

# Uses the default config.json in this directory
tool = create_excel_tool_from_config()

# Or specify a custom config file
tool = create_excel_tool_from_config(
    config_path="/path/to/custom_config.json"
)
```

## Available Tools

The Excel server provides a comprehensive set of tools for Excel manipulation. The exact tools and their parameters depend on the excel-mcp-server implementation.

Common operations include:

### File Operations
- **read_excel**: Read data from Excel files
- **write_excel**: Write data to Excel files
- **create_workbook**: Create new Excel workbooks

### Sheet Management
- **add_sheet**: Add new sheets to workbooks
- **remove_sheet**: Remove sheets from workbooks
- **rename_sheet**: Rename existing sheets
- **list_sheets**: Get list of all sheets in a workbook

### Cell Operations
- **read_cell**: Read value from specific cell
- **write_cell**: Write value to specific cell
- **format_cell**: Apply formatting to cells
- **merge_cells**: Merge multiple cells

### Data Analysis
- **calculate_formula**: Evaluate Excel formulas
- **create_chart**: Create charts from data
- **apply_filter**: Apply filters to data ranges
- **create_pivot**: Create pivot tables

For detailed tool documentation, see:
- [Excel MCP Server Tools Documentation](https://github.com/haris-musa/excel-mcp-server/blob/main/TOOLS.md)

## Example: Complete Workflow

```python
from gem.tools.mcp_server.excel import create_excel_tool

# Initialize the tool
tool = create_excel_tool(validate_on_init=False)

# Example action: Write data to Excel file
action1 = '''
<tool_call>
<tool_name>write_excel</tool_name>
<arguments>
{
  "file_path": "./data.xlsx",
  "data": [
    ["Name", "Age", "City"],
    ["Alice", 30, "New York"],
    ["Bob", 25, "Los Angeles"],
    ["Charlie", 35, "Chicago"]
  ]
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action1)
print(f"Result: {observation}")

# Example action: Read Excel file
action2 = '''
<tool_call>
<tool_name>read_excel</tool_name>
<arguments>
{
  "file_path": "./data.xlsx"
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action2)
print(f"Data: {observation}")

# Example action: Format cells
action3 = '''
<tool_call>
<tool_name>format_cell</tool_name>
<arguments>
{
  "file_path": "./data.xlsx",
  "cell": "A1",
  "format": {
    "bold": true,
    "font_size": 14,
    "background_color": "#CCCCCC"
  }
}
</arguments>
</tool_call>
'''

is_valid, has_error, observation, parsed = tool.execute_action(action3)
print(f"Format result: {observation}")
```

## Configuration

Default configuration (`config.json`):

```json
{
  "mcpServers": {
    "excel": {
      "command": "excel-mcp-server",
      "args": [
        "stdio"
      ]
    }
  }
}
```

## Integration with GEM

The Excel tool can be used with GEM environments:

```python
import gem
from gem.tools.mcp_server.excel import create_excel_tool
from gem.tools.tool_env_wrapper import ToolEnvWrapper

# Create environment
env = gem.make("your-env-id")

# Create Excel tool
excel_tool = create_excel_tool(validate_on_init=False)

# Wrap environment with tool
wrapped_env = ToolEnvWrapper(env, tools=[excel_tool])

# Use the environment
obs, info = wrapped_env.reset()
```

## Multi-Server Configuration

You can combine the Excel tool with other MCP servers:

```python
from gem.tools.mcp_server.excel import get_excel_stdio_config
from gem.tools.mcp_server.memory import get_memory_stdio_config
from gem.tools.mcp_tool import MCPTool

# Get individual configs
excel_config = get_excel_stdio_config()
memory_config = get_memory_stdio_config()

# Merge configs
merged_config = {
    "mcpServers": {
        **excel_config,
        **memory_config
    }
}

# Create combined tool
tool = MCPTool(merged_config, validate_on_init=False)

# Now you have both Excel and Memory tools available
tools = tool.get_available_tools()
```

## Troubleshooting

### "uv: command not found"
Make sure `uv` is installed:
```bash
# Install uv (if not already installed)
pip install uv
```

### "excel-mcp-server not found"
Install the Excel MCP server package:
```bash
uv pip install excel-mcp-server
```

### File Permission Errors
Make sure the directories where you're reading/writing Excel files are accessible:
```bash
chmod 755 /path/to/excel/files
```

### Timeout Issues
If operations are timing out, increase the timeout:
```python
tool = create_excel_tool(
    client_session_timeout_seconds=100,
    execution_timeout=60.0
)
```

## Testing

Run the test script to verify the installation:

```bash
python -m gem.tools.mcp_server.excel.test_excel_tool
```

This will:
1. Test connection to the Excel MCP server
2. Display available tools
3. Verify instruction string generation

## References

- [Excel MCP Server Repository](https://github.com/haris-musa/excel-mcp-server)
- [Excel MCP Server Tools Documentation](https://github.com/haris-musa/excel-mcp-server/blob/main/TOOLS.md)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [GEM Framework Documentation](https://github.com/axon-rl/gem)

## Notes

- The exact tool names and parameters depend on the excel-mcp-server implementation
- Refer to the [official documentation](https://github.com/haris-musa/excel-mcp-server/blob/main/TOOLS.md) for the most up-to-date tool specifications
- This module uses stdio transport for communication, which auto-starts the server as a subprocess
- The server timeout can be configured via `client_session_timeout_seconds` parameter

