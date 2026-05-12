"""Example usage of WooCommerce MCP Tool.

This example demonstrates how to use the WooCommerce MCP Tool with both
HTTP (FastMCP) and stdio modes.

Requirements:
    - WooCommerce server running (for HTTP mode) or mcp_convert installed (for stdio mode)
    - Data directory with WooCommerce data
"""

import asyncio
from pathlib import Path

from gem.tools.mcp_server.woocommerce import (
    create_woocommerce_tool_http,
    create_woocommerce_tool_stdio,
    get_woocommerce_stdio_config
)


async def example_http_mode():
    """Example using HTTP mode (FastMCP server).
    
    Requires starting the WooCommerce server first:
    cd mcp_convert/mcps/woocommerce && python server.py --transport streamable-http --port 8085
    """
    print("\n=== WooCommerce HTTP Mode Example ===")
    
    # Create tool (connects to running server)
    tool = create_woocommerce_tool_http(
        woocommerce_url="http://127.0.0.1:8085/woocommerce-mcp",
        validate_on_init=False
    )
    
    # Get available tools
    tools = tool.get_available_tools()
    print(f"\n📦 Available WooCommerce tools: {len(tools)}")
    print(f"Sample tools: {[t['name'] for t in tools[:5]]}")
    
    # Example 1: List products
    print("\n--- Example 1: List Products ---")
    action = '<tool_call><tool_name>woo_products_list</tool_name><parameters><perPage>5</perPage><orderby>date</orderby><order>desc</order></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")
    
    # Example 2: Get specific product
    print("\n--- Example 2: Get Product Details ---")
    action = '<tool_call><tool_name>woo_products_get</tool_name><parameters><productId>1</productId></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")
    
    # Example 3: List orders
    print("\n--- Example 3: List Orders ---")
    action = '<tool_call><tool_name>woo_orders_list</tool_name><parameters><perPage>5</perPage><status>completed</status></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")
    
    # Example 4: List customers
    print("\n--- Example 4: List Customers ---")
    action = '<tool_call><tool_name>woo_customers_list</tool_name><parameters><perPage>5</perPage></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")


async def example_stdio_mode():
    """Example using stdio mode (auto-starts server).
    
    No manual server startup needed! The server starts automatically.
    """
    print("\n=== WooCommerce stdio Mode Example ===")
    
    # Create tool (auto-starts server)
    tool = create_woocommerce_tool_stdio(
        data_dir="./woocommerce_data",
        validate_on_init=False
    )
    
    # Get available tools
    tools = tool.get_available_tools()
    print(f"\n📦 Available WooCommerce tools: {len(tools)}")
    print(f"Sample tools: {[t['name'] for t in tools[:5]]}")
    
    # Example 1: List products with filters
    print("\n--- Example 1: List Products ---")
    action = '<tool_call><tool_name>woo_products_list</tool_name><parameters><perPage>10</perPage><orderby>popularity</orderby></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")
    
    # Example 2: Search products
    print("\n--- Example 2: Search Products ---")
    action = '<tool_call><tool_name>woo_products_list</tool_name><parameters><search>shirt</search><perPage>5</perPage></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")
    
    # Example 3: Get order details
    print("\n--- Example 3: Get Order Details ---")
    action = '<tool_call><tool_name>woo_orders_get</tool_name><parameters><orderId>1</orderId></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")
    
    # Example 4: List coupons
    print("\n--- Example 4: List Coupons ---")
    action = '<tool_call><tool_name>woo_coupons_list</tool_name><parameters><perPage>5</perPage></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:500] if obs else 'No response'}...")


async def example_multi_server():
    """Example using multiple MCP servers together.
    
    Combines WooCommerce with other servers in a single MCPTool instance.
    """
    print("\n=== Multi-Server Example ===")
    
    from gem.tools.mcp_tool import MCPTool
    
    # Get WooCommerce config
    woocommerce_config = get_woocommerce_stdio_config(
        data_dir="./woocommerce_data",
        server_name="woocommerce"
    )
    
    # You can merge with other server configs here
    # For example:
    # from gem.tools.mcp_server.google_cloud import get_google_cloud_stdio_config
    # gcloud_config = get_google_cloud_stdio_config(data_dir="./google_cloud_data")
    
    # Merge configs
    merged_config = {
        "mcpServers": {
            **woocommerce_config,
            # **gcloud_config,  # Add other servers here
        }
    }
    
    # Create combined tool
    tool = MCPTool(merged_config, validate_on_init=False)
    
    # Get available tools from all servers
    tools = tool.get_available_tools()
    print(f"\n🔧 Total available tools: {len(tools)}")
    
    # List WooCommerce tools
    woo_tools = [t for t in tools if t['name'].startswith('woo_')]
    print(f"📦 WooCommerce tools: {len(woo_tools)}")
    print(f"Sample: {[t['name'] for t in woo_tools[:5]]}")
    
    # Example: Use WooCommerce tool
    print("\n--- Using WooCommerce Tool ---")
    action = '<tool_call><tool_name>woo_products_list</tool_name><parameters><perPage>3</perPage></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Error: {has_error}")
    print(f"Response preview: {obs[:300] if obs else 'No response'}...")


async def main():
    """Run all examples."""
    print("=" * 70)
    print("WooCommerce MCP Tool Examples")
    print("=" * 70)
    
    # Choose which examples to run
    run_http = False  # Set to True if you have the HTTP server running
    run_stdio = True   # stdio mode (auto-starts)
    run_multi = True   # Multi-server example
    
    if run_http:
        try:
            await example_http_mode()
        except Exception as e:
            print(f"\n❌ HTTP mode error: {e}")
            print("Make sure the WooCommerce server is running on port 8085")
    
    if run_stdio:
        try:
            await example_stdio_mode()
        except Exception as e:
            print(f"\n❌ stdio mode error: {e}")
            print("Make sure mcp_convert is installed and data directory exists")
    
    if run_multi:
        try:
            await example_multi_server()
        except Exception as e:
            print(f"\n❌ Multi-server error: {e}")
            print("Make sure all required servers are available")
    
    print("\n" + "=" * 70)
    print("Examples completed!")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())











