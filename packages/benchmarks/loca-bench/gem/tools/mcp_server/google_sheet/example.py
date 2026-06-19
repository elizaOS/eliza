"""Example usage of Google Sheet MCP Tool.

This example demonstrates how to use the Google Sheet MCP tool in both HTTP and stdio modes.
"""

from gem.tools.mcp_server.google_sheet import create_google_sheet_tool_stdio, create_google_sheet_tool_http


def example_stdio_mode():
    """Example using stdio mode (auto-starts server)."""
    print("=" * 60)
    print("Google Sheet MCP Tool - stdio mode example")
    print("=" * 60)
    
    # Create Google Sheet tool using stdio transport (auto-starts server)
    tool = create_google_sheet_tool_stdio(
        data_dir="./google_sheet_data",
        validate_on_init=False
    )
    
    print("\n1. Getting available tools...")
    tools = tool.get_available_tools()
    print(f"\nFound {len(tools)} tools:")
    for t in tools:
        print(f"  - {t['name']}: {t['description'][:80]}...")
    
    print("\n2. Listing all spreadsheets...")
    action = '<tool_call><tool_name>list_spreadsheets</tool_name></tool_call>'
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs[:500]}..." if len(obs) > 500 else f"Response: {obs}")
    
    print("\n3. Creating a new spreadsheet...")
    action = '<tool_call><tool_name>create_spreadsheet</tool_name><parameters><title>Test Spreadsheet</title></parameters></tool_call>'
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs}")
    
    print("\nstdio mode example completed!")


def example_http_mode():
    """Example using HTTP mode (requires manual server startup).
    
    Before running this, start the Google Sheet server:
        cd /path/to/mcp_convert/mcps/google_sheet
        python server.py --transport streamable-http --port 8086
    """
    print("=" * 60)
    print("Google Sheet MCP Tool - HTTP mode example")
    print("=" * 60)
    print("\nNote: Make sure the Google Sheet server is running on port 8086")
    print("Start it with: python server.py --transport streamable-http --port 8086\n")
    
    try:
        # Create Google Sheet tool using HTTP transport
        tool = create_google_sheet_tool_http(
            google_sheet_url="http://127.0.0.1:8086/google-sheet-mcp",
            validate_on_init=True
        )
        
        print("1. Getting available tools...")
        tools = tool.get_available_tools()
        print(f"\nFound {len(tools)} tools:")
        for t in tools:
            print(f"  - {t['name']}: {t['description'][:80]}...")
        
        print("\nHTTP mode example completed!")
        
    except Exception as e:
        print(f"Error: {e}")
        print("Make sure the Google Sheet server is running!")


def example_multi_server():
    """Example of combining Google Sheet with other MCP servers."""
    print("=" * 60)
    print("Google Sheet MCP Tool - Multi-server example")
    print("=" * 60)
    
    from gem.tools.mcp_tool import MCPTool
    from gem.tools.mcp_server.google_sheet import get_google_sheet_stdio_config
    
    # Get configs for multiple servers
    gsheet_config = get_google_sheet_stdio_config(
        data_dir="./google_sheet_data"
    )
    
    # You can add other servers here, e.g.:
    # from gem.tools.mcp_server.emails import get_email_stdio_config
    # email_config = get_email_stdio_config(data_dir="./email_data")
    
    # Merge configs
    merged_config = {
        "mcpServers": {
            **gsheet_config,
            # **email_config,  # Add other servers here
        }
    }
    
    # Create combined tool
    tool = MCPTool(merged_config, validate_on_init=False)
    
    print("\n1. Getting available tools from all servers...")
    tools = tool.get_available_tools()
    print(f"\nFound {len(tools)} tools in total")
    
    # Group tools by server
    sheet_tools = [t for t in tools if any(keyword in t['name'].lower() 
                   for keyword in ['sheet', 'spreadsheet', 'cell', 'row', 'column'])]
    print(f"\nGoogle Sheet tools: {len(sheet_tools)}")
    for t in sheet_tools[:5]:  # Show first 5
        print(f"  - {t['name']}")
    
    print("\nMulti-server example completed!")


def example_advanced_operations():
    """Example demonstrating advanced Google Sheets operations."""
    print("=" * 60)
    print("Google Sheet MCP Tool - Advanced Operations")
    print("=" * 60)
    
    # Create tool
    tool = create_google_sheet_tool_stdio(
        data_dir="./google_sheet_data",
        validate_on_init=False
    )
    
    # Example 1: Get sheet data
    print("\n1. Getting sheet data...")
    action = '<tool_call><tool_name>get_sheet_data</tool_name><parameters><spreadsheet_id>test_spreadsheet_1</spreadsheet_id><sheet>Sheet1</sheet><range>A1:C10</range></parameters></tool_call>'
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs[:500]}..." if len(obs) > 500 else f"Response: {obs}")
    
    # Example 2: Update cells
    print("\n2. Updating cells...")
    action = '''<tool_call><tool_name>update_cells</tool_name><parameters><spreadsheet_id>test_spreadsheet_1</spreadsheet_id><sheet>Sheet1</sheet><range>A1:B2</range><data>[["Header1", "Header2"], ["Value1", "Value2"]]</data></parameters></tool_call>'''
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs[:500]}..." if len(obs) > 500 else f"Response: {obs}")
    
    # Example 3: List sheets in a spreadsheet
    print("\n3. Listing sheets in spreadsheet...")
    action = '<tool_call><tool_name>list_sheets</tool_name><parameters><spreadsheet_id>test_spreadsheet_1</spreadsheet_id></parameters></tool_call>'
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs}")
    
    # Example 4: Create a new sheet
    print("\n4. Creating a new sheet...")
    action = '<tool_call><tool_name>create_sheet</tool_name><parameters><spreadsheet_id>test_spreadsheet_1</spreadsheet_id><title>New Sheet</title></parameters></tool_call>'
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs}")
    
    # Example 5: Add rows
    print("\n5. Adding rows to sheet...")
    action = '<tool_call><tool_name>add_rows</tool_name><parameters><spreadsheet_id>test_spreadsheet_1</spreadsheet_id><sheet>Sheet1</sheet><count>5</count></parameters></tool_call>'
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs}")
    
    print("\nAdvanced operations example completed!")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        mode = sys.argv[1]
        if mode == "stdio":
            example_stdio_mode()
        elif mode == "http":
            example_http_mode()
        elif mode == "multi":
            example_multi_server()
        elif mode == "advanced":
            example_advanced_operations()
        else:
            print(f"Unknown mode: {mode}")
            print("Usage: python example.py [stdio|http|multi|advanced]")
    else:
        # Run stdio mode by default
        example_stdio_mode()

