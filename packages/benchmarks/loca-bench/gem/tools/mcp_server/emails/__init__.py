"""Email MCP Server - Email Management System Integration.

This module provides access to Email functionality through MCP.

Two modes available:
1. HTTP mode (FastMCP server) - Requires manual server startup
2. stdio mode (original server) - Auto-starts, no manual setup needed

Examples:
    # HTTP mode (FastMCP server)
    from gem.tools.mcp_server.emails import create_email_tool_http
    tool = create_email_tool_http(validate_on_init=False)
    
    # stdio mode (original server, auto-starts)
    from gem.tools.mcp_server.emails import create_email_tool_stdio
    tool = create_email_tool_stdio(
        data_dir="./email_data",
        validate_on_init=False
    )
"""

from .helper import (
    create_email_tool,
    create_email_tool_http,
    create_email_tool_stdio,
    get_email_stdio_config,
)

__all__ = [
    'create_email_tool',
    'create_email_tool_http',
    'create_email_tool_stdio',
    'get_email_stdio_config',
]

