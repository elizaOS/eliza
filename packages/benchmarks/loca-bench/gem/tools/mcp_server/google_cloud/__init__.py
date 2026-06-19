"""Google Cloud MCP Server - Google Cloud Platform Integration.

This module provides access to Google Cloud Platform functionality through MCP.
Supports BigQuery, Cloud Storage, Compute Engine, and IAM using local JSON database.

Two modes available:
1. HTTP mode (FastMCP server) - Requires manual server startup
2. stdio mode (original server) - Auto-starts, no manual setup needed

Examples:
    # HTTP mode (FastMCP server)
    from gem.tools.mcp_server.google_cloud import create_google_cloud_tool_http
    tool = create_google_cloud_tool_http(validate_on_init=False)
    
    # stdio mode (original server, auto-starts)
    from gem.tools.mcp_server.google_cloud import create_google_cloud_tool_stdio
    tool = create_google_cloud_tool_stdio(
        data_dir="./google_cloud_data",
        validate_on_init=False
    )
"""

from .helper import (
    create_google_cloud_tool,
    create_google_cloud_tool_http,
    create_google_cloud_tool_stdio,
    get_google_cloud_stdio_config,
)

__all__ = [
    'create_google_cloud_tool',
    'create_google_cloud_tool_http',
    'create_google_cloud_tool_stdio',
    'get_google_cloud_stdio_config',
]























