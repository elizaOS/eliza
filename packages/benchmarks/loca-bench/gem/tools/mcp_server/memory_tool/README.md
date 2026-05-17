# Memory Tool MCP Server

An MCP server that provides memory management tools for file operations in a sandboxed `/memories` directory.

## Features

The memory_tool server provides 6 tools for file and directory management:

- **view**: View directory contents or file contents in the /memories directory
- **create**: Create or overwrite files in the /memories directory
- **str_replace**: Replace unique text in files
- **insert**: Insert text at specific line numbers
- **delete**: Delete files or directories
- **rename**: Rename or move files/directories

## Security

- All operations are sandboxed to the `/memories` directory
- Path validation prevents directory traversal attacks
- Only specific file extensions are allowed for creation (.txt, .md, .json, .py, .yaml, .yml)

## Usage

### Standalone Usage

#### Via stdio transport:
```python
from gem.tools.mcp_server.memory_tool import create_memory_tool_stdio

# Create the tool
tool = create_memory_tool_stdio(base_path="/path/to/storage")

# Use in environment
from gem.tools.tool_env_wrapper import ToolEnvWrapperOpenAI
env = ToolEnvWrapperOpenAI(base_env, tools=[tool])
```

#### Via HTTP transport:
```bash
# Start the server
python -m gem.tools.mcp_server.memory_tool.server --transport streamable-http --port 8085 --base-path /path/to/storage
```

```python
from gem.tools.mcp_server.memory_tool import create_memory_tool_http

# Connect to the server
tool = create_memory_tool_http(port=8085)
```

### Integration with run_multi_openai_v2.py

Add the memory_tool server to your configuration JSON:

```json
{
  "configurations": [
    {
      "env_class": "gem.envs.your_env.YourEnv",
      "env_params": {
        "seed": 42
      },
      "mcp_servers": {
        "memory_tool": {
          "type": "memory_tool",
          "enabled": true,
          "params": {
            "base_path": "{agent_workspace}/memory_storage"
          }
        }
      }
    }
  ]
}
```

#### Automatic MEMORY PROTOCOL Injection

When `memory_tool` is included and enabled in the configuration, `run_multi_openai_v2.py` automatically injects the following instructions into the initial user prompt:

```
IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.
MEMORY PROTOCOL:
1. Use the `view` command of your `memory` tool to check for earlier progress.
2. ... (work on the task) ...
     - As you make progress, record status / progress / thoughts etc in your memory.
ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory.
```

This ensures that the agent:
- Checks memory directory first to see if there's any previous progress
- Records progress continuously during task execution
- Is aware that context might be reset at any time

The injection is automatic and requires no additional configuration. Simply enable the memory_tool server and the protocol will be added to the system prompt.

You can also use the alternative name `memory-tool`:

```json
{
  "type": "memory-tool",
  "params": {
    "base_path": "/custom/path/to/storage"
  }
}
```

### Configuration with Multiple Servers

Combine memory_tool with other MCP servers:

```json
{
  "mcp_servers": {
    "memory_tool": {
      "type": "memory_tool",
      "enabled": true,
      "params": {
        "base_path": "{agent_workspace}/memory_storage",
        "server_name": "memory_tool"
      }
    },
    "python_execute": {
      "type": "python_execute",
      "enabled": true,
      "params": {
        "workspace_path": "{agent_workspace}"
      }
    },
    "claim_done": {
      "type": "claim_done",
      "enabled": true,
      "params": {}
    }
  }
}
```

### Path Placeholders

In configuration files, you can use the following placeholders:
- `{task_workspace}`: Replaced with the task workspace path
- `{agent_workspace}`: Replaced with the agent workspace path

### Working with Pre-populated Memory

Some environments (like `canvas_arrange_exam_s2l`) include pre-populated memory data in their `initial_workspace/memory` directory. These files are automatically copied to two locations during environment initialization:

1. **Original location**: `{agent_workspace}/memory/` - For backward compatibility
2. **Memory tool location**: `{agent_workspace}/memory/memories/` - For memory_tool access

To enable memory_tool to access these pre-populated files, set the base_path as follows:

```json
{
  "memory_tool": {
    "type": "memory_tool",
    "enabled": true,
    "params": {
      "base_path": "{agent_workspace}/memory"
    }
  }
}
```

With this configuration:
- memory_tool's `/memories` path maps to `{agent_workspace}/memory/memories`
- Pre-populated files in `initial_workspace/memory/` are accessible via memory_tool

**Directory Structure Example:**
```
agent_workspace/
└── memory/
    ├── memory.json              # Original location
    └── memories/
        └── memory.json          # Accessible via memory_tool at /memories/memory.json
```

## Tool Descriptions

### view
View directory contents or file contents in the /memories directory.

Parameters:
- `path` (required): Path to view (must start with /memories)
- `view_range` (optional): List of [start_line, end_line] for viewing specific lines

### create
Create or overwrite a file in the /memories directory.

Parameters:
- `path` (required): Path to create file at (must start with /memories and end with supported extension)
- `file_text` (optional): Content to write to the file

### str_replace
Replace text in a file in the /memories directory.

Parameters:
- `path` (required): Path to file (must start with /memories)
- `old_str` (required): Text to replace (must be unique in the file)
- `new_str` (optional): Text to replace with

### insert
Insert text at a specific line in a file in the /memories directory.

Parameters:
- `path` (required): Path to file (must start with /memories)
- `insert_line` (required): Line number to insert at (0-indexed)
- `insert_text` (optional): Text to insert

### delete
Delete a file or directory in the /memories directory.

Parameters:
- `path` (required): Path to delete (must start with /memories)

### rename
Rename or move a file/directory in the /memories directory.

Parameters:
- `old_path` (required): Current path (must start with /memories)
- `new_path` (required): New path (must start with /memories)

## Testing

Run the test suite:

```bash
python gem/tools/mcp_server/memory_tool/test_memory_tool_mcp.py
```

## Example Usage

See `inference/example_memory_tool_config.json` for example configurations.

## Related

This server is based on Claude's `memory_20250818` tool specification but implements it as a standalone MCP server for use in the GEM framework.

For the original Anthropic memory tool implementation, see `gem/tools/mcp_server/memory_tool/memory_tool.py` and `demo_helpers.py`.
