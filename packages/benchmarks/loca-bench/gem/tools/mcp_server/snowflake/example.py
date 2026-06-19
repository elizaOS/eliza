#!/usr/bin/env python3
"""Example usage of Snowflake MCP Tool.

This script demonstrates how to use the Snowflake MCP tool
with both HTTP and stdio modes.
"""

import sys
import os

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
sys.path.insert(0, project_root)


def example_stdio_mode():
    """Example using stdio mode (auto-starts server)."""
    print("=" * 60)
    print("Snowflake MCP Tool - stdio Mode Example")
    print("=" * 60)
    
    from gem.tools.mcp_server.snowflake import create_snowflake_tool_stdio
    
    # Create tool with stdio transport (auto-starts server)
    tool = create_snowflake_tool_stdio(
        data_dir="./snowflake_data",
        validate_on_init=False
    )
    
    print("\n1. Getting available tools...")
    tools = tool.get_available_tools()
    print(f"   Found {len(tools)} tools:")
    for t in tools:
        print(f"   - {t['name']}: {t.get('description', 'No description')[:60]}...")
    
    print("\n2. Listing databases...")
    action = '<tool_call><tool_name>list_databases</tool_name></tool_call>'
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   Valid: {is_valid}, Error: {has_error}")
    print(f"   Result:\n{obs[:500]}...")
    
    print("\n3. Listing schemas in PURCHASE_INVOICE database...")
    action = '''<tool_call>
<tool_name>list_schemas</tool_name>
<parameters>
<database>PURCHASE_INVOICE</database>
</parameters>
</tool_call>'''
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   Valid: {is_valid}, Error: {has_error}")
    print(f"   Result:\n{obs[:500]}...")
    
    print("\n4. Listing tables in PURCHASE_INVOICE.PUBLIC...")
    action = '''<tool_call>
<tool_name>list_tables</tool_name>
<parameters>
<database>PURCHASE_INVOICE</database>
<schema>PUBLIC</schema>
</parameters>
</tool_call>'''
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   Valid: {is_valid}, Error: {has_error}")
    print(f"   Result:\n{obs[:500]}...")
    
    print("\n5. Executing a SELECT query...")
    action = '''<tool_call>
<tool_name>read_query</tool_name>
<parameters>
<query>SELECT * FROM PURCHASE_INVOICE.PUBLIC.INVOICES LIMIT 3</query>
</parameters>
</tool_call>'''
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"   Valid: {is_valid}, Error: {has_error}")
    print(f"   Result:\n{obs[:800]}...")
    
    print("\n" + "=" * 60)
    print("stdio Mode Example Complete!")
    print("=" * 60)


def example_http_mode():
    """Example using HTTP mode (requires manual server start)."""
    print("=" * 60)
    print("Snowflake MCP Tool - HTTP Mode Example")
    print("=" * 60)
    print("\nNote: HTTP mode requires the server to be running first:")
    print("  cd /path/to/mcp_convert/mcps/snowflake")
    print("  python server.py --transport streamable-http --port 8086")
    print()
    
    from gem.tools.mcp_server.snowflake import create_snowflake_tool_http
    
    try:
        # Create tool with HTTP transport
        tool = create_snowflake_tool_http(
            snowflake_url="http://127.0.0.1:8086/snowflake-mcp",
            validate_on_init=False
        )
        
        print("1. Getting available tools...")
        tools = tool.get_available_tools()
        print(f"   Found {len(tools)} tools")
        
        print("\n2. Listing databases...")
        action = '<tool_call><tool_name>list_databases</tool_name></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        print(f"   Valid: {is_valid}, Error: {has_error}")
        print(f"   Result:\n{obs[:500]}...")
        
    except Exception as e:
        print(f"   Error: {e}")
        print("   Make sure the Snowflake server is running on port 8086")
    
    print("\n" + "=" * 60)
    print("HTTP Mode Example Complete!")
    print("=" * 60)


def example_config_only():
    """Example of getting config for multi-server setup."""
    print("=" * 60)
    print("Snowflake MCP Tool - Config Only Example")
    print("=" * 60)
    
    from gem.tools.mcp_server.snowflake import get_snowflake_stdio_config
    
    # Get config (without creating tool)
    config = get_snowflake_stdio_config(
        data_dir="./snowflake_data",
        server_name="snowflake"
    )
    
    print("\n1. Generated config:")
    import json
    print(json.dumps(config, indent=2))
    
    print("\n2. This config can be merged with other server configs:")
    print("""
    from gem.tools.mcp_tool import MCPTool
    from gem.tools.mcp_server.snowflake import get_snowflake_stdio_config
    from gem.tools.mcp_server.claim_done import get_claim_done_stdio_config
    
    # Merge configs
    merged_config = {
        "mcpServers": {
            **get_snowflake_stdio_config(data_dir="./snowflake_data"),
            **get_claim_done_stdio_config()
        }
    }
    
    # Create combined tool
    tool = MCPTool(merged_config, validate_on_init=False)
    """)
    
    print("\n" + "=" * 60)
    print("Config Only Example Complete!")
    print("=" * 60)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Snowflake MCP Tool Examples")
    parser.add_argument(
        "--mode",
        choices=["stdio", "http", "config"],
        default="stdio",
        help="Which example to run (default: stdio)"
    )
    
    args = parser.parse_args()
    
    if args.mode == "stdio":
        example_stdio_mode()
    elif args.mode == "http":
        example_http_mode()
    elif args.mode == "config":
        example_config_only()






