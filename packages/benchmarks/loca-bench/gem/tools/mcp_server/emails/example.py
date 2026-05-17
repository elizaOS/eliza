"""Example usage of Email MCP Tool.

This example demonstrates how to use the Email MCP tool in both HTTP and stdio modes.
"""

from gem.tools.mcp_server.emails import create_email_tool_stdio, create_email_tool_http


def example_stdio_mode():
    """Example using stdio mode (auto-starts server)."""
    print("=" * 60)
    print("Email MCP Tool - stdio mode example")
    print("=" * 60)
    
    # Create Email tool using stdio transport (auto-starts server)
    tool = create_email_tool_stdio(
        data_dir="./email_data",
        email="user1@example.com",  # Optional: auto-login
        password="password123",      # Optional: auto-login
        validate_on_init=False
    )
    
    print("\n1. Getting available tools...")
    tools = tool.get_available_tools()
    print(f"\nFound {len(tools)} tools:")
    for t in tools:
        print(f"  - {t['name']}: {t['description']}")
    
    print("\n2. Getting current user...")
    action = '''<tool_call>
<tool_name>get_current_user</tool_name>
<parameters>
{}
</parameters>
</tool_call>'''
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs}")
    
    print("\n3. Listing all users...")
    action = '''<tool_call>
<tool_name>list_users</tool_name>
<parameters>
{}
</parameters>
</tool_call>'''
    
    is_valid, has_error, obs, parsed = tool.execute_action(action)
    print(f"Valid: {is_valid}, Has Error: {has_error}")
    print(f"Response: {obs}")
    
    print("\nstdio mode example completed!")


def example_http_mode():
    """Example using HTTP mode (requires manual server startup).
    
    Before running this, start the Email server:
        cd /path/to/mcp_convert/mcps/email
        python server.py --transport streamable-http --port 8083
    """
    print("=" * 60)
    print("Email MCP Tool - HTTP mode example")
    print("=" * 60)
    print("\nNote: Make sure the Email server is running on port 8083")
    print("Start it with: python server.py --transport streamable-http --port 8083\n")
    
    try:
        # Create Email tool using HTTP transport
        tool = create_email_tool_http(
            email_url="http://127.0.0.1:8083/email-mcp",
            validate_on_init=True
        )
        
        print("1. Getting available tools...")
        tools = tool.get_available_tools()
        print(f"\nFound {len(tools)} tools:")
        for t in tools:
            print(f"  - {t['name']}: {t['description']}")
        
        print("\nHTTP mode example completed!")
        
    except Exception as e:
        print(f"Error: {e}")
        print("Make sure the Email server is running!")


def example_multi_server():
    """Example of combining Email with other MCP servers."""
    print("=" * 60)
    print("Email MCP Tool - Multi-server example")
    print("=" * 60)
    
    from gem.tools.mcp_tool import MCPTool
    from gem.tools.mcp_server.emails import get_email_stdio_config
    
    # Get configs for multiple servers
    email_config = get_email_stdio_config(
        data_dir="./email_data",
        email="user1@example.com",
        password="password123"
    )
    
    # You can add other servers here, e.g.:
    # from gem.tools.mcp_server.canvas import get_canvas_stdio_config
    # canvas_config = get_canvas_stdio_config(data_dir="./canvas_data")
    
    # Merge configs
    merged_config = {
        "mcpServers": {
            **email_config,
            # **canvas_config,  # Add other servers here
        }
    }
    
    # Create combined tool
    tool = MCPTool(merged_config, validate_on_init=False)
    
    print("\n1. Getting available tools from all servers...")
    tools = tool.get_available_tools()
    print(f"\nFound {len(tools)} tools in total")
    
    # Group tools by server
    email_tools = [t for t in tools if 'email' in t['name'].lower() or 'mail' in t['name'].lower()]
    print(f"\nEmail tools: {len(email_tools)}")
    for t in email_tools[:5]:  # Show first 5
        print(f"  - {t['name']}")
    
    print("\nMulti-server example completed!")


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
        else:
            print(f"Unknown mode: {mode}")
            print("Usage: python example.py [stdio|http|multi]")
    else:
        # Run stdio mode by default
        example_stdio_mode()

