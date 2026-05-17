# Programmatic Tool Calling - Architecture Design

## Overview

The `programmatic_tool_calling` MCP server enables Python code execution with embedded tool calling capabilities. Unlike the basic `python_execute` server, this allows code to invoke tools as function calls, with execution pausing while tools are executed.

## Problem Statement

Standard MCP tools execute one at a time based on agent decisions. However, some tasks require:

1. **Sequential tool calls with logic**: Loop over files and process each
2. **Conditional tool calls**: Make tool calls based on runtime conditions
3. **Pre/post processing**: Complex logic around tool invocations
4. **Multi-step workflows**: Chain tools with intermediate data transformations

## Solution Architecture

### Key Innovation: Tool Executor Callback Pattern

Since MCP servers run in separate processes (for isolation), we cannot directly access the parent process's tool environment. The solution uses a **callback pattern**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Parent Process (Agent/Tool Environment)                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────┐          │
│  │ Tool Environment                                  │          │
│  │  - filesystem_tool                                │          │
│  │  - memory_tool                                    │          │
│  │  - programmatic_tool_calling_tool                 │          │
│  │    + tool_executor callback ───────┐             │          │
│  └────────────────────────────────────┼─────────────┘          │
│                                         │                        │
│                    MCP stdio/HTTP       │                        │
│                         │               │                        │
└─────────────────────────┼───────────────┼────────────────────────┘
                          │               │
                          ▼               │ Callback
┌─────────────────────────────────────────┼────────────────────────┐
│ Child Process (MCP Server)              │                        │
│                                         │                        │
│  ┌───────────────────────────────┐     │                        │
│  │ Python Code Execution         │     │                        │
│  │                               │     │                        │
│  │  files = tools.list_files()  ─┼─────┘ Triggers callback      │
│  │  content = tools.read_file()  │       to parent process      │
│  │  ...                          │                              │
│  └───────────────────────────────┘                              │
│                                                                  │
│  ToolCallInterceptor:                                           │
│  - Intercepts tools.* attribute access                          │
│  - Routes to executor callback                                  │
│  - Returns result back to code                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Components

#### 1. Server (`server.py`)



**Key Classes**:

- `ToolCallInterceptor`: Intercepts attribute access on the `tools` object
  - Uses `__getattr__` to capture any `tools.tool_name()` call
  - Routes calls to the executor callback
  - Returns observation back to executing code

**Main Tool**:

```python
@app.tool()
def programmatic_tool_calling(code, filename=None, timeout=30, _tools_available=None):
    """Execute Python code with tool calling support."""
```

**Execution Flow**:

1. Receive Python code as string
2. Create `ToolCallInterceptor` with executor callback
3. Inject interceptor as `tools` in execution globals
4. Execute code using `exec()`
5. Capture stdout/stderr
6. Return structured result with tool call history

#### 2. Helper (`helper.py`)


**Key Classes**:

- `ProgrammaticToolCallingTool(MCPTool)`: Extended MCPTool with executor support
  - Stores `tool_executor` callback
  - Provides `set_tool_executor()` to update callback
  - Inherits all MCPTool functionality

**Helper Functions**:

```python
def create_programmatic_tool_calling_tool_stdio(
    workspace_path=None,
    tool_executor=None,  # The key parameter!
    validate_on_init=False
):
    """Create tool with stdio transport."""
```

#### 3. Tool Executor Pattern

The `tool_executor` is a callback function with signature:

```python
def tool_executor(
    tool_name: str,
    tool_args: dict,
    tool_call_id: str
) -> Tuple[bool, bool, str, str, str]:
    """
    Execute a tool by routing to the tool environment.

    Returns:
        (tool_parsed, tool_execute_error, observation,
         returned_tool_name, returned_tool_call_id)
    """
```

**Implementation Example**:

```python
def my_tool_executor(tool_name, tool_args, tool_call_id):
    # Route to available tools in the environment
    for tool in available_tools:
        result = tool.execute_tool(tool_name, tool_args, tool_call_id)
        if result[0]:  # tool_parsed == True
            return result

    # Tool not found
    return (False, True, f"Tool not found: {tool_name}",
            tool_name, tool_call_id)
```

## Data Flow

### 1. Tool Creation

```python
# Create filesystem tool
filesystem_tool = create_filesystem_tool(workspace_path="./workspace")

# Create executor that routes to filesystem_tool
def executor(tool_name, tool_args, tool_call_id):
    return filesystem_tool.execute_tool(tool_name, tool_args, tool_call_id)

# Create programmatic tool with executor
prog_tool = create_programmatic_tool_calling_tool_stdio(
    workspace_path="./workspace",
    tool_executor=executor
)
```

### 2. Code Execution

```python
# User's code that will be executed
code = '''
files = tools.list_files(path=".")
content = tools.read_file(path=files[0])
result = content.upper()
'''

# Execute via programmatic tool
result = prog_tool.execute_tool(
    "programmatic_tool_calling",
    {"code": code},
    "call_123"
)
```

### 3. Internal Execution Flow

```
1. MCPTool sends code to server
      ↓
2. Server creates ToolCallInterceptor(executor)
      ↓
3. Server injects interceptor as 'tools' in exec() globals
      ↓
4. Code executes: tools.list_files(path=".")
      ↓
5. Interceptor captures via __getattr__("list_files")
      ↓
6. Interceptor calls executor("list_files", {"path": "."}, "call_abc")
      ↓
7. Executor routes to filesystem_tool.execute_tool()
      ↓
8. filesystem_tool executes via MCP and returns result
      ↓
9. Executor returns result to Interceptor
      ↓
10. Interceptor returns observation to code
      ↓
11. Code continues: content = tools.read_file(...)
      ↓
12. ... (repeat 5-10 for each tool call)
      ↓
13. Code completes, server returns structured result
```

## Output Format

The tool returns a JSON string with:

```json
{
  "success": true,
  "execution_time_seconds": 1.234,
  "timeout_limit_seconds": 30,
  "stdout": "Console output from code execution",
  "stderr": "Error output if any",
  "tool_calls": [
    {
      "tool_name": "list_files",
      "args": {"path": "."},
      "tool_call_id": "call_abc123",
      "parsed": true,
      "has_error": false
    }
  ],
  "tool_results": [
    {
      "tool_call_id": "call_abc123",
      "observation": "[\"file1.txt\", \"file2.py\"]",
      "has_error": false
    }
  ],
  "return_value": "PROCESSED CONTENT",
  "error": null,
  "file_path": "/path/to/.python_tmp/file.py"
}
```

## Design Decisions

### 1. Why Callback Pattern?

**Alternatives Considered**:

- ❌ **Direct tool access**: Server can't access parent process tools (process isolation)
- ❌ **Shared memory**: Complex, platform-specific, fragile
- ❌ **Socket communication**: Adds complexity, requires port management
- ✅ **Callback pattern**: Clean, works with MCP architecture, no new infrastructure

### 2. Why Not Use MCP Resources?

MCP Resources are for data retrieval, not for executing actions. Tool calls need to:
- Modify state (write files, update memory)
- Have side effects
- Return execution results

Resources are read-only by design.

### 3. Why Separate from python_execute?

Keeping them separate allows:
- Clear separation of concerns
- Independent evolution
- Users choose complexity level
- Easier testing and debugging

## Limitations & Future Work

### Current Limitations

1. **Synchronous Only**: Tool calls block until completion
2. **No Parallelization**: Tools execute sequentially
3. **Process Boundary**: Callback overhead on each tool call
4. **Error Context**: Limited traceback across process boundary

### Future Enhancements

1. **Async Support**: `await tools.async_read_file(...)`
2. **Parallel Execution**: `results = await asyncio.gather(*tool_calls)`
3. **Caching**: Memoize repeated tool calls
4. **Streaming**: Stream tool outputs for long operations
5. **Debugging**: Better error traces across process boundary

## Testing Strategy

### Unit Tests (`test_programmatic_tool_calling.py`)

- Mock executor for isolated testing
- Test single tool call
- Test multiple sequential calls
- Test error handling
- Test pre/post processing logic

### Integration Tests (`example_usage.py`)

- Real tools (filesystem, memory)
- Complex workflows
- Error scenarios
- Performance benchmarks

## Comparison with Alternatives

| Approach | Pros | Cons |
|----------|------|------|
| **Sequential Agent Calls** | Simple, standard pattern | No conditional logic, no loops |
| **python_execute** | Fast, simple | No tool access |
| **programmatic_tool_calling** | Full Python + tools | Callback overhead |
| **Custom DSL** | Type-safe | Learning curve, limited expressiveness |

## Integration with ToolEnvWrapper

The `tool_executor` can be integrated with `ToolEnvWrapper`:

```python
class MyToolEnv(ToolEnvWrapper):
    def __init__(self, base_env):
        # Create executor using self.tools
        def executor(tool_name, tool_args, tool_call_id):
            for tool in self.tools:
                result = tool.execute_tool(tool_name, tool_args, tool_call_id)
                if result[0]:
                    return result
            return (False, True, f"Tool not found", tool_name, tool_call_id)

        # Create programmatic tool
        prog_tool = create_programmatic_tool_calling_tool_stdio(
            workspace_path="./workspace",
            tool_executor=executor
        )

        # Initialize with all tools
        super().__init__(base_env, tools=[prog_tool, other_tools...])
```

## Summary

The `programmatic_tool_calling` server bridges the gap between:
- **Flexibility**: Full Python programming with loops, conditionals, data structures
- **Tool Access**: Call any available tool programmatically
- **Process Isolation**: MCP servers remain isolated for security/stability

This enables complex, multi-step workflows while maintaining the security and modularity of the MCP architecture.
