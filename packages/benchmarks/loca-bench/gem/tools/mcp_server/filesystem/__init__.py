"""Filesystem MCP server integration.

This module provides helper functions for creating MCPTool instances
that connect to the @modelcontextprotocol/server-filesystem MCP server.

The Filesystem server allows file and directory operations within
a specified allowed directory.
"""

from .helper import create_filesystem_tool, get_filesystem_stdio_config

__all__ = [
    "create_filesystem_tool",
    "get_filesystem_stdio_config",
]

