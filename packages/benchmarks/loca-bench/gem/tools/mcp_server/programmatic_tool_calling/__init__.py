"""Programmatic Tool Calling MCP Server

An MCP server that provides Python code execution with embedded tool calling capabilities.
When code execution encounters a tool call, it pauses, executes the tool via the tool executor,
and continues with the tool result injected back into the code execution context.
"""

from .helper import (
    create_programmatic_tool_calling_tool_http,
    create_programmatic_tool_calling_tool_stdio,
    get_programmatic_tool_calling_stdio_config,
    ProgrammaticToolCallingTool,
)

__all__ = [
    "create_programmatic_tool_calling_tool_stdio",
    "create_programmatic_tool_calling_tool_http",
    "get_programmatic_tool_calling_stdio_config",
    "ProgrammaticToolCallingTool",
]
