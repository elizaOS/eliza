"""Terminal MCP Server - Command Execution System.

This module provides access to the cli-mcp-server MCP server,
which implements safe terminal command execution with comprehensive
access controls and output management.

The Terminal server communicates through stdio transport.

Package: https://github.com/MladenSU/cli-mcp-server
"""

from .helper import (
    create_terminal_tool,
    create_terminal_tool_from_config,
    get_terminal_stdio_config,
)

__all__ = [
    "create_terminal_tool",
    "create_terminal_tool_from_config",
    "get_terminal_stdio_config",
]

