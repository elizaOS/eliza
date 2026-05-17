"""Calendar MCP Server - Google Calendar Integration.

This module provides access to Google Calendar functionality through MCP.

Two modes available:
1. HTTP mode (FastMCP server) - Requires manual server startup
2. stdio mode (original server) - Auto-starts, no manual setup needed

Examples:
    # HTTP mode (FastMCP server)
    from gem.tools.mcp_server.calendar import create_calendar_tool_http
    tool = create_calendar_tool_http(validate_on_init=False)
    
    # stdio mode (original server, auto-starts)
    from gem.tools.mcp_server.calendar import create_calendar_tool_stdio
    tool = create_calendar_tool_stdio(
        data_dir="./calendar_data",
        validate_on_init=False
    )
"""

from .helper import (
    create_calendar_tool,
    create_calendar_tool_http,
    create_calendar_tool_stdio,
    get_calendar_stdio_config,
)

__all__ = [
    'create_calendar_tool',
    'create_calendar_tool_http',
    'create_calendar_tool_stdio',
    'get_calendar_stdio_config',
]











