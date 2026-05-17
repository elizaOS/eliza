"""Canvas MCP Server - Learning Management System Integration.

This module provides access to Canvas LMS functionality through MCP.

Two modes available:
1. HTTP mode (FastMCP server) - Requires manual server startup
2. stdio mode (original server) - Auto-starts, no manual setup needed

Examples:
    # HTTP mode (FastMCP server)
    from gem.tools.mcp_server.canvas import create_canvas_tool_http
    tool = create_canvas_tool_http(validate_on_init=False)
    
    # stdio mode (original server, auto-starts)
    from gem.tools.mcp_server.canvas import create_canvas_tool_stdio
    tool = create_canvas_tool_stdio(
        data_dir="./canvas_data",
        validate_on_init=False
    )
"""

from .helper import (
    create_canvas_tool,
    create_canvas_tool_http,
    create_canvas_tool_stdio,
)

__all__ = [
    "create_canvas_tool",
    "create_canvas_tool_http",
    "create_canvas_tool_stdio",
]