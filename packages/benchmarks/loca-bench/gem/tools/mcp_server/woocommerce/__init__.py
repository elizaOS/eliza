"""WooCommerce MCP Server - WooCommerce REST API Integration.

This module provides access to WooCommerce functionality through MCP.
Supports products, orders, customers, coupons, and more using local JSON database.

Two modes available:
1. HTTP mode (FastMCP server) - Requires manual server startup
2. stdio mode (original server) - Auto-starts, no manual setup needed

Examples:
    # HTTP mode (FastMCP server)
    from gem.tools.mcp_server.woocommerce import create_woocommerce_tool_http
    tool = create_woocommerce_tool_http(validate_on_init=False)
    
    # stdio mode (original server, auto-starts)
    from gem.tools.mcp_server.woocommerce import create_woocommerce_tool_stdio
    tool = create_woocommerce_tool_stdio(
        data_dir="./woocommerce_data",
        validate_on_init=False
    )
"""

from .helper import (
    create_woocommerce_tool,
    create_woocommerce_tool_http,
    create_woocommerce_tool_stdio,
    get_woocommerce_stdio_config,
)

__all__ = [
    'create_woocommerce_tool',
    'create_woocommerce_tool_http',
    'create_woocommerce_tool_stdio',
    'get_woocommerce_stdio_config',
]











