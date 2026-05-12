"""Example: Using WooCommerce with other MCP servers.

This example demonstrates how to combine WooCommerce with Google Cloud
and Email MCP servers in a single MCPTool instance.

This allows you to use tools from all servers seamlessly.
"""

import asyncio
from pathlib import Path


async def example_combined_servers():
    """Example using WooCommerce, Google Cloud, and Email servers together."""
    print("=" * 70)
    print("Multi-Server Example: WooCommerce + Google Cloud + Email")
    print("=" * 70)
    
    from gem.tools.mcp_tool import MCPTool
    from gem.tools.mcp_server.woocommerce import get_woocommerce_stdio_config
    from gem.tools.mcp_server.google_cloud import get_google_cloud_stdio_config
    from gem.tools.mcp_server.emails import get_email_stdio_config
    
    # Get individual server configs
    print("\n1. Configuring servers...")
    woocommerce_config = get_woocommerce_stdio_config(
        data_dir="./woocommerce_data",
        server_name="woocommerce"
    )
    print("   ✓ WooCommerce configured")
    
    gcloud_config = get_google_cloud_stdio_config(
        data_dir="./google_cloud_data",
        server_name="google-cloud"
    )
    print("   ✓ Google Cloud configured")
    
    email_config = get_email_stdio_config(
        data_dir="./email_data",
        server_name="email"
    )
    print("   ✓ Email configured")
    
    # Merge configs
    merged_config = {
        "mcpServers": {
            **woocommerce_config,
            **gcloud_config,
            **email_config,
        }
    }
    
    # Create combined tool
    print("\n2. Creating combined MCPTool...")
    tool = MCPTool(merged_config, validate_on_init=False)
    print("   ✓ Tool created")
    
    # Get available tools from all servers
    print("\n3. Discovering tools...")
    tools = tool.get_available_tools()
    print(f"   Total tools available: {len(tools)}")
    
    # Categorize tools by server
    woo_tools = [t for t in tools if t['name'].startswith('woo_')]
    bq_tools = [t for t in tools if t['name'].startswith('bigquery_')]
    storage_tools = [t for t in tools if t['name'].startswith('storage_')]
    email_tools = [t for t in tools if 'email' in t['name'].lower() or 'mail' in t['name'].lower()]
    
    print(f"\n   WooCommerce tools: {len(woo_tools)}")
    print(f"   Sample: {[t['name'] for t in woo_tools[:3]]}")
    
    print(f"\n   BigQuery tools: {len(bq_tools)}")
    print(f"   Sample: {[t['name'] for t in bq_tools[:3]]}")
    
    print(f"\n   Cloud Storage tools: {len(storage_tools)}")
    print(f"   Sample: {[t['name'] for t in storage_tools[:3]]}")
    
    print(f"\n   Email tools: {len(email_tools)}")
    print(f"   Sample: {[t['name'] for t in email_tools[:3]]}")
    
    # Example 1: Use WooCommerce
    print("\n4. Example operations:")
    print("\n   --- WooCommerce: List Products ---")
    action = '<tool_call><tool_name>woo_products_list</tool_name><parameters><perPage>5</perPage></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   Valid: {is_valid}, Error: {has_error}")
    if obs:
        print(f"   Response preview: {obs[:200]}...")
    
    # Example 2: Use BigQuery
    print("\n   --- Google Cloud: List BigQuery Datasets ---")
    action = '<tool_call><tool_name>bigquery_list_datasets</tool_name></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   Valid: {is_valid}, Error: {has_error}")
    if obs:
        print(f"   Response preview: {obs[:200]}...")
    
    # Example 3: Use Email
    print("\n   --- Email: Get Current User ---")
    action = '<tool_call><tool_name>get_current_user</tool_name></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   Valid: {is_valid}, Error: {has_error}")
    if obs:
        print(f"   Response preview: {obs[:200]}...")
    
    print("\n" + "=" * 70)
    print("✓ Multi-server example complete!")
    print("=" * 70)


async def example_business_workflow():
    """Example: Cross-server business workflow.
    
    Scenario: Check product inventory, query sales data from BigQuery,
    and send notification email about low stock.
    """
    print("\n" + "=" * 70)
    print("Business Workflow Example: Inventory Alert System")
    print("=" * 70)
    
    from gem.tools.mcp_tool import MCPTool
    from gem.tools.mcp_server.woocommerce import get_woocommerce_stdio_config
    from gem.tools.mcp_server.google_cloud import get_google_cloud_stdio_config
    from gem.tools.mcp_server.emails import get_email_stdio_config
    
    # Setup multi-server tool
    print("\n1. Setting up multi-server tool...")
    config = {
        "mcpServers": {
            **get_woocommerce_stdio_config(data_dir="./woocommerce_data"),
            **get_google_cloud_stdio_config(data_dir="./google_cloud_data"),
            **get_email_stdio_config(data_dir="./email_data"),
        }
    }
    tool = MCPTool(config, validate_on_init=False)
    print("   ✓ Multi-server tool ready")
    
    # Step 1: Check WooCommerce inventory
    print("\n2. Checking product inventory in WooCommerce...")
    action = '<tool_call><tool_name>woo_products_list</tool_name><parameters><stockStatus>instock</stockStatus><perPage>10</perPage></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   ✓ Retrieved product inventory")
    
    # Step 2: Query sales analytics from BigQuery
    print("\n3. Querying sales analytics from BigQuery...")
    # Example query for sales data
    query = "SELECT product_id, SUM(quantity) as total_sold FROM orders_table GROUP BY product_id"
    action = f'<tool_call><tool_name>bigquery_run_query</tool_name><parameters><query>{query}</query><projectId>my-project</projectId></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   ✓ Analyzed sales data")
    
    # Step 3: Check for low stock products
    print("\n4. Identifying low stock products...")
    action = '<tool_call><tool_name>woo_products_list</tool_name><parameters><stockStatus>outofstock</stockStatus><perPage>5</perPage></parameters></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   ✓ Found low stock items")
    
    # Step 4: Send alert email
    print("\n5. Sending inventory alert email...")
    email_content = {
        "to": "inventory@company.com",
        "subject": "Low Inventory Alert",
        "body": "Several products are running low on stock. Please review."
    }
    # Note: Use appropriate email sending tool based on your email server
    action = '<tool_call><tool_name>send_email</tool_name><parameters>...</parameters></tool_call>'
    print(f"   ✓ Alert email prepared")
    
    print("\n" + "=" * 70)
    print("✓ Business workflow complete!")
    print("\nThis example demonstrates:")
    print("  - Checking inventory (WooCommerce)")
    print("  - Analytics queries (Google Cloud BigQuery)")
    print("  - Email notifications (Email server)")
    print("  - All in one unified tool interface!")
    print("=" * 70)


async def main():
    """Run all examples."""
    print("\n" + "=" * 70)
    print("WooCommerce Multi-Server Integration Examples")
    print("=" * 70)
    
    try:
        # Example 1: Basic multi-server usage
        await example_combined_servers()
        
        # Example 2: Business workflow
        await example_business_workflow()
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        print("\nMake sure:")
        print("  1. All required servers are installed (mcp_convert)")
        print("  2. Data directories exist with proper data files")
        print("  3. gem.tools modules are available")
    
    print("\n" + "=" * 70)
    print("Examples completed!")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())

