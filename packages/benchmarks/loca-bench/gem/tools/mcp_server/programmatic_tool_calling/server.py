#!/usr/bin/env python3
"""
Programmatic Tool Calling MCP Server

An MCP server that provides Python code execution with embedded tool calling capabilities.
When code execution encounters a tool call, it pauses, executes the tool via the tool executor,
and continues with the tool result injected back into the code execution context.

Based on python_execute MCP server but with programmatic tool calling support.
"""

import os
import sys
import time
import uuid
import json
import traceback
from pathlib import Path
from typing import Annotated, Optional, List, Dict, Any, Callable
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr

# Suppress FastMCP banner and reduce log level (must be before import)
os.environ["FASTMCP_SHOW_CLI_BANNER"] = "false"
os.environ["FASTMCP_LOG_LEVEL"] = "ERROR"

# Suppress logging output
import logging
logging.basicConfig(level=logging.ERROR, force=True)
logging.getLogger().setLevel(logging.ERROR)
for _logger_name in ["mcp", "fastmcp", "mcp.server", "mcp.client", "httpx", "asyncio", "uvicorn", "uvicorn.error", "uvicorn.access"]:
    logging.getLogger(_logger_name).setLevel(logging.ERROR)

# Add parent directory to path for imports
gem_root = Path(__file__).parent.parent.parent.parent.parent
if str(gem_root) not in sys.path:
    sys.path.insert(0, str(gem_root))

from fastmcp import FastMCP

# Create FastMCP server
app = FastMCP("Programmatic Tool Calling Server")

# Default workspace (can be overridden by environment variable)
DEFAULT_WORKSPACE = "."

# Global tool executor - will be set by the tool that creates this server
_tool_executor: Optional[Callable[[str, Dict[str, Any]], tuple]] = None


def set_tool_executor(executor: Callable[[str, Dict[str, Any]], tuple]):
    """Set the tool executor function.

    The executor should be a callable that takes (tool_name, tool_args) and returns:
    (tool_parsed, tool_execute_error, observation, returned_tool_name, returned_tool_call_id)
    """
    global _tool_executor
    _tool_executor = executor


def get_workspace() -> str:
    """Get the workspace directory from environment or use default."""
    return os.environ.get("PROGRAMMATIC_TOOL_CALLING_WORKSPACE", DEFAULT_WORKSPACE)


class ToolCallInterceptor:
    """
    A class that intercepts function calls and records them for later execution.

    Since MCP servers run in separate processes, actual tool execution happens
    in the parent process. This class just records tool calls and returns
    placeholder values that will be replaced with actual results later.
    """

    def __init__(self, tool_results_cache: Optional[Dict[str, str]] = None):
        """
        Args:
            tool_results_cache: Pre-computed results from previous tool executions
                               Format: {tool_call_id: observation}
        """
        self.tool_calls_made = []
        self.tool_results = []
        self.tool_results_cache = tool_results_cache or {}

    def __getattr__(self, tool_name: str):
        """Intercept any attribute access as a potential tool call."""
        def tool_function(**kwargs):
            """Record the tool call and return cached result if available."""
            # Generate a deterministic cache key based on tool name and args
            # This ensures the same call gets the same result across passes
            import json
            import hashlib
            args_str = json.dumps(kwargs, sort_keys=True)
            cache_key = f"{tool_name}:{args_str}"
            hash_suffix = hashlib.md5(cache_key.encode()).hexdigest()[:8]
            tool_call_id = f"call_{hash_suffix}"

            # Record the tool call
            self.tool_calls_made.append({
                "tool_name": tool_name,
                "args": kwargs,
                "tool_call_id": tool_call_id,
            })

            # Check if we have a cached result for this call
            if tool_call_id in self.tool_results_cache:
                observation = self.tool_results_cache[tool_call_id]
                has_error = False
            else:
                # First pass - return a placeholder
                # This will trigger re-execution after tools are actually run
                observation = f"__TOOL_CALL_PENDING_{tool_call_id}__"
                has_error = False

            # Record the result
            self.tool_results.append({
                "tool_call_id": tool_call_id,
                "observation": observation,
                "has_error": has_error,
            })

            return observation

        return tool_function


@app.tool()
def code_execution(
    code: Annotated[str, "Python code to execute that may include tool calls as function invocations"],
    filename: Annotated[Optional[str], "Filename for the Python file (including .py extension). If not provided, a random UUID will be used."] = None,
    timeout: Annotated[Optional[int], "Maximum execution time in seconds. Cannot exceed 120 seconds. Default is 30 seconds."] = 30,
    tool_results_cache: Annotated[Optional[Dict[str, str]], "Pre-computed tool results from previous execution pass. Format: {tool_call_id: observation}"] = None,
    _tools_available: Annotated[Optional[List[str]], "List of tool names that are available for calling (optional, for documentation)"] = None
) -> str:
    """
    Execute Python code that can programmatically call other tools within loops, conditionals, and complex logic.

    USE THIS WHEN YOU NEED TO:
    - Process multiple items in a loop (e.g., read/process all files in a directory)
    - Make decisions with if/else based on tool results (e.g., check if file exists, then read or create)
    - Chain multiple tool calls with intermediate processing (e.g., read data, transform it, write results)
    - Implement complex workflows that require computation between tool calls

    DO NOT USE THIS FOR:
    - Single simple tool calls (just call the tool directly instead)
    - Linear workflows without loops or conditions

    HOW TO USE:
    Write Python code that calls tools via the 'tools' object:

    Example 1 - Batch processing:
        files = tools.filesystem_list_directory(path=".")
        for file in files:
            if file.endswith('.txt'):
                content = tools.filesystem_read_file(path=file)
                processed = content.upper()
                tools.filesystem_write_file(path=f"processed_{file}", content=processed)
        result = "Batch processing complete"

    Example 2 - Conditional workflow:
        entities = tools.memory_search_nodes(query="user_status")
        if len(entities) == 0:
            tools.memory_create_entities(entities=[{"name": "status", "entityType": "config"}])
        result = "Status initialized"

    The code executes normally, and all tool calls return real results (not placeholders).
    Use 'result' variable to return a final value. Use print() for debugging output.

    Args:
        code: Python code to execute that may include tool calls via 'tools' object
        filename: Optional filename for the Python file
        timeout: Maximum execution time in seconds (max 120)
        tool_results_cache: Internal parameter for multi-pass execution (do not use)
        _tools_available: Internal parameter for documentation (do not use)

    Returns:
        JSON string with execution results. The following fields are visible to you:
        {
            "success": bool,                    // Whether execution succeeded without errors
            "execution_time_seconds": float,    // Time taken to execute (seconds)
            "timeout_limit_seconds": int,       // Timeout limit that was applied
            "stdout": str | null,               // Captured standard output (from print statements)
            "stderr": str | null,               // Captured standard error
            "return_value": str | null,         // Value of 'result' variable if defined in code
            "error": {                          // Error details if execution failed
                "type": str,                    // Exception type name
                "message": str,                 // Error message
                "traceback": str                // Full traceback
            } | null
        }

        Note: Internal fields like "tool_calls", "tool_results", "file_path", and "needs_tool_execution"
        are filtered out and not visible to you. They are used internally for multi-pass execution.
    """

    try:
        # Ensure timeout is reasonable
        if timeout is None:
            timeout = 30
        if timeout > 120:
            timeout = 120

        # Generate filename if not provided
        if filename is None:
            filename = f"programmatic_{uuid.uuid4().hex[:8]}.py"

        # Ensure filename ends with .py
        if not filename.endswith(".py"):
            filename += ".py"

        # Get workspace
        agent_workspace = get_workspace()
        agent_workspace = os.path.abspath(agent_workspace)

        # Create .python_tmp directory
        tmp_dir = os.path.join(agent_workspace, '.python_tmp')
        os.makedirs(tmp_dir, exist_ok=True)

        # Save the code to a file for debugging
        file_path = os.path.join(tmp_dir, filename)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(code)

        # Create tool interceptor with cache
        interceptor = ToolCallInterceptor(tool_results_cache)

        # Prepare execution environment
        exec_globals = {
            "__name__": "__main__",
            "__file__": file_path,
            "tools": interceptor,  # Inject the tool interceptor
            "WORKSPACE": agent_workspace,  # Provide workspace path for file operations
        }

        # Capture stdout and stderr
        stdout_capture = StringIO()
        stderr_capture = StringIO()

        # Track execution time
        start_time = time.time()

        # Execute the code
        execution_error = None
        return_value = None

        try:
            with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
                # Compile and execute the code
                compiled_code = compile(code, file_path, 'exec')
                exec(compiled_code, exec_globals)

                # Check if there's a return value (if code defined a main function or similar)
                if 'result' in exec_globals:
                    return_value = exec_globals['result']

        except Exception as e:
            execution_error = {
                "type": type(e).__name__,
                "message": str(e),
                "traceback": traceback.format_exc(),
            }

        # Calculate execution time
        execution_time = time.time() - start_time

        # Get captured output
        stdout_content = stdout_capture.getvalue()
        stderr_content = stderr_capture.getvalue()

        # Check if there are pending tool calls
        needs_tool_execution = any(
            "__TOOL_CALL_PENDING_" in str(tr.get("observation", ""))
            for tr in interceptor.tool_results
        )

        # Build structured result
        result = {
            "success": execution_error is None,
            "execution_time_seconds": round(execution_time, 3),
            "timeout_limit_seconds": timeout,
            "stdout": stdout_content if stdout_content else None,
            "stderr": stderr_content if stderr_content else None,
            "tool_calls": interceptor.tool_calls_made,
            "tool_results": interceptor.tool_results,
            "needs_tool_execution": needs_tool_execution,
            "return_value": str(return_value) if return_value is not None else None,
            "error": execution_error,
            "file_path": file_path,
        }

        return json.dumps(result, indent=2)

    except Exception as e:
        # Top-level error (e.g., file I/O error)
        return json.dumps({
            "success": False,
            "error": {
                "type": type(e).__name__,
                "message": str(e),
                "traceback": traceback.format_exc(),
            }
        }, indent=2)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Programmatic Tool Calling MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default="stdio",
        help="Transport type (default: stdio)"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to (for HTTP transport)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8085,
        help="Port to bind to (for HTTP transport, default: 8085)"
    )
    parser.add_argument(
        "--workspace",
        default=".",
        help="Agent workspace directory (default: current directory)"
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Logging level"
    )

    args = parser.parse_args()

    # Set workspace environment variable
    os.environ["PROGRAMMATIC_TOOL_CALLING_WORKSPACE"] = os.path.abspath(args.workspace)

    # Note: Tool executor must be set via set_tool_executor() before use
    print("Warning: Tool executor not configured. Use set_tool_executor() to configure.", file=sys.stderr)

    # Run the server
    if args.transport == "stdio":
        app.run(transport="stdio", show_banner=False)
    else:
        app.run(
            transport="streamable-http",
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            show_banner=False
        )
