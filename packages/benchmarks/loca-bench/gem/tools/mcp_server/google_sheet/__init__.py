"""Google Sheet MCP Server - Google Sheets Integration.

This module provides access to Google Sheets functionality through MCP.
Supports spreadsheet operations, sheet management, and data manipulation using local JSON database.

Two modes available:
1. HTTP mode (FastMCP server) - Requires manual server startup
2. stdio mode (original server) - Auto-starts, no manual setup needed

Examples:
    # HTTP mode (FastMCP server)
    from gem.tools.mcp_server.google_sheet import create_google_sheet_tool_http
    tool = create_google_sheet_tool_http(validate_on_init=False)
    
    # stdio mode (original server, auto-starts)
    from gem.tools.mcp_server.google_sheet import create_google_sheet_tool_stdio
    tool = create_google_sheet_tool_stdio(
        data_dir="./google_sheet_data",
        validate_on_init=False
    )
"""

from .helper import (
    create_google_sheet_tool,
    create_google_sheet_tool_http,
    create_google_sheet_tool_stdio,
    get_google_sheet_stdio_config,
)

__all__ = [
    'create_google_sheet_tool',
    'create_google_sheet_tool_http',
    'create_google_sheet_tool_stdio',
    'get_google_sheet_stdio_config',
]









