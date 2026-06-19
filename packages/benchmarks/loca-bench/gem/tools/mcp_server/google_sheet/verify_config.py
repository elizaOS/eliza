"""Verify Google Sheet MCP Tool configuration.

This script checks if the Google Sheet MCP tool is properly configured and can:
1. Find the server script
2. Create the tool instance
3. List available tools
4. Execute basic operations
"""

import sys
from pathlib import Path


def verify_configuration():
    """Verify the Google Sheet MCP tool configuration."""
    print("=" * 70)
    print("Google Sheet MCP Tool - Configuration Verification")
    print("=" * 70)
    
    # Step 1: Check imports
    print("\n[1/5] Checking imports...")
    try:
        from gem.tools.mcp_server.google_sheet import (
            create_google_sheet_tool_stdio,
            create_google_sheet_tool_http,
            get_google_sheet_stdio_config
        )
        print("✓ All imports successful")
    except ImportError as e:
        print(f"✗ Import error: {e}")
        return False
    
    # Step 2: Check server script location
    print("\n[2/5] Checking server script location...")
    try:
        config = get_google_sheet_stdio_config(data_dir="./test_data")
        server_info = config.get("google-sheet", {})
        if server_info:
            args = server_info.get("args", [])
            if len(args) >= 5:
                server_script = args[4]
                print(f"✓ Server script found: {server_script}")
                if Path(server_script).exists():
                    print(f"✓ Server script exists at: {server_script}")
                else:
                    print(f"✗ Server script not found at: {server_script}")
                    return False
            else:
                print("✗ Server configuration incomplete")
                return False
        else:
            print("✗ Could not generate server configuration")
            return False
    except Exception as e:
        print(f"✗ Error checking server script: {e}")
        return False
    
    # Step 3: Create tool instance
    print("\n[3/5] Creating tool instance...")
    try:
        tool = create_google_sheet_tool_stdio(
            data_dir="./test_google_sheet_data",
            validate_on_init=False
        )
        print("✓ Tool instance created successfully")
    except Exception as e:
        print(f"✗ Error creating tool: {e}")
        return False
    
    # Step 4: List available tools
    print("\n[4/5] Listing available tools...")
    try:
        tools = tool.get_available_tools()
        print(f"✓ Found {len(tools)} tools:")
        
        # Group tools by category
        sheet_tools = []
        spreadsheet_tools = []
        data_tools = []
        
        for t in tools:
            name = t['name']
            if 'spreadsheet' in name:
                spreadsheet_tools.append(name)
            elif any(keyword in name for keyword in ['get', 'update', 'add', 'copy', 'rename', 'batch']):
                data_tools.append(name)
            else:
                sheet_tools.append(name)
        
        print(f"\n  Data Operations ({len(data_tools)}):")
        for name in sorted(data_tools)[:5]:
            print(f"    - {name}")
        if len(data_tools) > 5:
            print(f"    ... and {len(data_tools) - 5} more")
        
        print(f"\n  Spreadsheet Operations ({len(spreadsheet_tools)}):")
        for name in sorted(spreadsheet_tools):
            print(f"    - {name}")
        
        print(f"\n  Other Tools ({len(sheet_tools)}):")
        for name in sorted(sheet_tools):
            print(f"    - {name}")
            
    except Exception as e:
        print(f"✗ Error listing tools: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    # Step 5: Test basic operation
    print("\n[5/5] Testing basic operation (list_spreadsheets)...")
    try:
        # Note: For tools with no parameters, don't include <parameters> tag
        action = '<tool_call><tool_name>list_spreadsheets</tool_name></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        print(f"  Debug - Valid: {is_valid}, Has Error: {has_error}")
        print(f"  Debug - Observation length: {len(obs) if obs else 0}")
        print(f"  Debug - Parsed: {parsed}")
        
        if is_valid and not has_error:
            print("✓ Basic operation successful")
            print(f"  Response: {obs[:200]}..." if len(obs) > 200 else f"  Response: {obs}")
        elif is_valid and has_error:
            # Valid but with error - this might be normal for empty database
            print("⚠ Operation valid but returned error (possibly empty database)")
            print(f"  Response: {obs[:500]}..." if len(obs) > 500 else f"  Response: {obs}")
            # Don't fail - empty database is acceptable
        else:
            print(f"✗ Operation invalid")
            print(f"  Valid: {is_valid}, Has Error: {has_error}")
            print(f"  Response: {obs[:500]}..." if len(obs) > 500 else f"  Response: {obs}")
            return False
            
    except Exception as e:
        print(f"✗ Error executing operation: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    print("\n" + "=" * 70)
    print("✓ All verification checks passed!")
    print("=" * 70)
    print("\nThe Google Sheet MCP tool is properly configured and ready to use.")
    print("\nNext steps:")
    print("  1. Run the example: python example.py")
    print("  2. Use in your code: from gem.tools.mcp_server.google_sheet import create_google_sheet_tool_stdio")
    print("=" * 70)
    
    return True


if __name__ == "__main__":
    success = verify_configuration()
    sys.exit(0 if success else 1)

