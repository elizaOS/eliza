"""Snowflake MCP Server - Snowflake Database Integration.

This module provides access to Snowflake functionality through MCP.
Supports database queries, schema exploration, and data insights using local SQLite database.

Two modes available:
1. HTTP mode (FastMCP server) - Requires manual server startup
2. stdio mode (original server) - Auto-starts, no manual setup needed

Examples:
    # HTTP mode (FastMCP server)
    from gem.tools.mcp_server.snowflake import create_snowflake_tool_http
    tool = create_snowflake_tool_http(validate_on_init=False)
    
    # stdio mode (original server, auto-starts)
    from gem.tools.mcp_server.snowflake import create_snowflake_tool_stdio
    tool = create_snowflake_tool_stdio(
        data_dir="./snowflake_data",
        validate_on_init=False
    )
"""

from .helper import (
    create_snowflake_tool,
    create_snowflake_tool_http,
    create_snowflake_tool_stdio,
    get_snowflake_stdio_config,
)

__all__ = [
    'create_snowflake_tool',
    'create_snowflake_tool_http',
    'create_snowflake_tool_stdio',
    'get_snowflake_stdio_config',
]






