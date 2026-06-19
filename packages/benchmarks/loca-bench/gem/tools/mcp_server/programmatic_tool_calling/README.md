# Programmatic Tool Calling MCP Server

An MCP server that executes Python code with embedded tool calling capabilities. When code execution encounters a tool call, the execution pauses, executes the tool, and continues with the result.

## Features

- Execute Python code with tool calls as function invocations
- Support for multiple sequential tool calls within code
- Pre/post-processing logic around tool calls
- Structured output with tool call history and results
- Error handling and timeout support

## Architecture

### How It Works

Due to MCP architecture where servers run in separate processes, this implementation uses a **tool executor callback pattern**:

1. **Client Side**: Create a `ProgrammaticToolCallingTool` instance with a tool executor callback
2. **Server Side**: When code calls `tools.tool_name(args)`, it triggers the executor
3. **Executor**: Routes the call back to the parent process's tool environment
4. **Result**: Tool result is injected back into code execution

### Key Components

```
┌─────────────────────────────────────────────────────────┐
│ Main Process (Your Agent/Tool Environment)              │
│                                                          │
│  ┌────────────────────────────────────────────┐        │
│  │ ProgrammaticToolCallingTool                │        │
│  │ + tool_executor callback                    │        │
│  └──────────────┬─────────────────────────────┘        │
│                 │                                        │
│                 │ MCP Protocol (stdio/HTTP)              │
│                 │                                        │
│  ┌──────────────▼─────────────────────────────┐        │
│  │ MCP Server (Separate Process)              │        │
│  │                                              │        │
│  │  ┌────────────────────────────────┐        │        │
│  │  │ Python Code Execution          │        │        │
│  │  │   tools.read_file(...)  ──┐   │        │        │
│  │  │   tools.list_files(...) ──┼───┼────────┼─────►  │
│  │  │   tools.write_file(...) ──┘   │        │   Calls│
│  │  └────────────────────────────────┘        │   Back │
│  │                                              │   to   │
│  │  ToolCallInterceptor                        │  Parent│
│  │  + Captures tool calls                      │        │
│  │  + Routes via executor callback             │        │
│  └──────────────────────────────────────────────┘        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Installation

No additional installation needed - uses standard `gem` dependencies.

## Usage

### Basic Example

```python
from gem.tools.mcp_server.programmatic_tool_calling import (
    create_programmatic_tool_calling_tool_stdio
)

# Create a tool executor that routes to your tools
def my_tool_executor(tool_name, tool_args, tool_call_id):
    """Execute tools by routing to your tool environment."""
    # Loop through available tools and execute
    for tool in my_available_tools:
        result = tool.execute_tool(tool_name, tool_args, tool_call_id)
        if result[0]:  # tool_parsed
            return result
    # Tool not found
    return (False, True, f"Tool {tool_name} not found", tool_name, tool_call_id)

# Create the programmatic tool calling tool
prog_tool = create_programmatic_tool_calling_tool_stdio(
    workspace_path="/path/to/workspace",
    tool_executor=my_tool_executor,
    validate_on_init=False
)

# Use it in your tool environment
env = ToolEnvWrapper(base_env, tools=[prog_tool, other_tools...])
```

### Example Code with Tool Calls

```python
# This is the code that will be executed by programmatic_tool_calling
code = '''
# List files in the directory
files = tools.list_files(path=".")
print(f"Found {len(files)} files")

# Read the first file
if files:
    content = tools.read_file(path=files[0])
    print(f"Content: {content}")

    # Process the content
    processed = content.upper()

    # Write to a new file
    tools.write_file(path="output.txt", content=processed)
    print("Processed and saved!")

result = "Success"
'''

# Execute via the tool
tool_parsed, has_error, observation, tool_name, tool_call_id = prog_tool.execute_tool(
    "programmatic_tool_calling",
    {"code": code},
    "my_call_id"
)

# Parse the structured result
import json
result = json.loads(observation)
print(f"Success: {result['success']}")
print(f"Tool calls made: {len(result['tool_calls'])}")
print(f"Stdout: {result['stdout']}")
```

### Integration with ToolEnvWrapper

```python
from gem.tools.tool_env_wrapper import ToolEnvWrapper
from gem.tools.mcp_server.programmatic_tool_calling import (
    create_programmatic_tool_calling_tool_stdio
)

# Create tool environment
class MyToolEnvironment(ToolEnvWrapper):
    def __init__(self, base_env):
        # Create tool executor that uses self.tools
        def tool_executor(tool_name, tool_args, tool_call_id):
            for tool in self.tools:
                result = tool.execute_tool(tool_name, tool_args, tool_call_id)
                if result[0]:  # tool_parsed
                    return result
            return (False, True, f"Tool not found: {tool_name}", tool_name, tool_call_id)

        # Create programmatic tool calling tool
        prog_tool = create_programmatic_tool_calling_tool_stdio(
            workspace_path="./workspace",
            tool_executor=tool_executor,
            validate_on_init=False
        )

        # Initialize with all tools
        super().__init__(
            base_env,
            tools=[prog_tool, filesystem_tool, other_tools...]
        )
```

## API Reference

### `programmatic_tool_calling` Tool

**Parameters:**
- `code` (str): Python code to execute with tool calls
- `tools_available` (List[str], optional): List of available tool names (for documentation)
- `filename` (str, optional): Filename for the Python file (default: random UUID)
- `timeout` (int, optional): Max execution time in seconds (default: 30, max: 120)

**Returns:**
A JSON string with:
```json
{
  "success": true,
  "execution_time_seconds": 1.234,
  "timeout_limit_seconds": 30,
  "stdout": "console output...",
  "stderr": "error output...",
  "tool_calls": [
    {
      "tool_name": "read_file",
      "args": {"path": "test.txt"},
      "tool_call_id": "call_abc123",
      "parsed": true,
      "has_error": false
    }
  ],
  "tool_results": [
    {
      "tool_call_id": "call_abc123",
      "observation": "file content...",
      "has_error": false
    }
  ],
  "return_value": "final result",
  "error": null,
  "file_path": "/path/to/temp/file.py"
}
```

### Helper Functions

#### `create_programmatic_tool_calling_tool_stdio`
Create tool using stdio transport (subprocess).

```python
tool = create_programmatic_tool_calling_tool_stdio(
    workspace_path: str = None,
    tool_executor: Callable = None,
    validate_on_init: bool = False
)
```

#### `create_programmatic_tool_calling_tool_http`
Create tool using HTTP transport (requires separate server).

```python
tool = create_programmatic_tool_calling_tool_http(
    host: str = "127.0.0.1",
    port: int = 8085,
    tool_executor: Callable = None,
    validate_on_init: bool = True
)
```

#### `ProgrammaticToolCallingTool`
Extended MCPTool class with tool executor support.

```python
tool = ProgrammaticToolCallingTool(config, tool_executor=executor)
tool.set_tool_executor(new_executor)  # Update executor
```

## Code Execution Environment

The executed code has access to:
- `tools`: ToolCallInterceptor object for making tool calls
- `__name__`: Set to `"__main__"`
- `__file__`: Path to the temporary Python file
- Standard library imports work normally

## Error Handling

Tool execution errors are raised as `RuntimeError` exceptions in the code:

```python
code = '''
try:
    result = tools.some_tool(arg="value")
except RuntimeError as e:
    print(f"Tool failed: {e}")
    result = "error handled"
'''
```

## Limitations

1. **Process Isolation**: The tool executor must be serializable or handle cross-process communication
2. **Timeout**: Code execution is limited by the timeout parameter (max 120s)
3. **Tool Discovery**: Tools must be explicitly made available via the executor callback
4. **No Interactive I/O**: Code cannot use `input()` or other interactive features

## Testing

Run the test suite:

```bash
python -m gem.tools.mcp_server.programmatic_tool_calling.test_programmatic_tool_calling
```

## Comparison with `python_execute`

| Feature | `python_execute` | `programmatic_tool_calling` |
|---------|------------------|----------------------------|
| Execute Python code | ✓ | ✓ |
| Tool calls | ✗ | ✓ |
| Pre/post processing | ✓ | ✓ |
| Loop over tool calls | ✗ | ✓ |
| Structured output | ✓ | ✓ (with tool history) |
| Complexity | Simple | Moderate |

## Use Cases

1. **Batch Operations**: Loop over files and process each with tools
2. **Conditional Tool Calls**: Make tool calls based on runtime conditions
3. **Multi-Step Workflows**: Chain multiple tool calls with intermediate processing
4. **Complex Logic**: Implement business logic that uses tools as primitives

## Future Enhancements

- [ ] Support for async tool execution
- [ ] Tool call parallelization
- [ ] Better error context and debugging
- [ ] Tool call caching/memoization
- [ ] Integration with agent frameworks
