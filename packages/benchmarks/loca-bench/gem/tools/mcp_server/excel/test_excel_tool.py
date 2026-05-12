#!/usr/bin/env python3
"""Test script for Excel MCP server integration."""

import json
import sys
import tempfile
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.excel import create_excel_tool


def test_basic_connection():
    """Test basic connection and tool discovery."""
    print("=" * 60)
    print("Testing Excel MCP Server Connection")
    print("=" * 60)
    
    try:
        # Create tool
        tool = create_excel_tool(validate_on_init=True)
        
        print("✓ Successfully created Excel tool")
        
        # Get available tools
        tools = tool.get_available_tools()
        print(f"\n✓ Found {len(tools)} available tools:")
        for t in tools:
            print(f"  - {t['name']}: {t['description']}")
        
        return tool
        
    except Exception as e:
        print(f"\n✗ Failed to create Excel tool: {e}")
        import traceback
        traceback.print_exc()
        return None


def test_read_excel(tool, test_file):
    """Test reading an Excel file."""
    print("\n" + "=" * 60)
    print("Testing Excel File Reading")
    print("=" * 60)
    
    # This is a generic test - actual tool name and parameters may vary
    # Adjust based on actual excel-mcp-server tool specifications
    action = f'''
<tool_call>
<tool_name>read_excel</tool_name>
<arguments>
{{
  "file_path": "{test_file}"
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Successfully read Excel file")
            print(f"Result: {observation}")
        else:
            print(f"✗ Failed to read Excel file: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during read test: {e}")
        return False


def test_write_excel(tool, test_file):
    """Test writing to an Excel file."""
    print("\n" + "=" * 60)
    print("Testing Excel File Writing")
    print("=" * 60)
    
    # This is a generic test - actual tool name and parameters may vary
    action = f'''
<tool_call>
<tool_name>write_excel</tool_name>
<arguments>
{{
  "file_path": "{test_file}",
  "data": [
    ["Name", "Age", "City"],
    ["Alice", 30, "New York"],
    ["Bob", 25, "Los Angeles"],
    ["Charlie", 35, "Chicago"]
  ]
}}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, observation, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Successfully wrote to Excel file")
            print(f"Result: {observation}")
        else:
            print(f"✗ Failed to write Excel file: {observation}")
        
        return is_valid and not has_error
    except Exception as e:
        print(f"✗ Exception during write test: {e}")
        return False


def test_instruction_string(tool):
    """Test instruction string generation."""
    print("\n" + "=" * 60)
    print("Testing Instruction String")
    print("=" * 60)
    
    instruction = tool.instruction_string()
    
    print("\nGenerated instruction string (first 1000 chars):")
    print("-" * 60)
    print(instruction[:1000])
    print("...")
    print("-" * 60)
    
    return True


def main():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("Excel MCP Server Test Suite")
    print("=" * 60)
    print("\nNote: This will use 'excel-mcp-server stdio'")
    print("Make sure excel-mcp-server is installed via: uv pip install excel-mcp-server\n")
    
    # Test connection
    tool = test_basic_connection()
    if not tool:
        print("\n✗ Connection test failed. Exiting.")
        print("\nMake sure excel-mcp-server is installed:")
        print("  uv pip install excel-mcp-server")
        return 1
    
    # Test instruction string
    test_instruction_string(tool)
    
    # Create a temporary Excel file for testing
    with tempfile.TemporaryDirectory() as tmpdir:
        test_file = Path(tmpdir) / "test.xlsx"
        
        # Test write operation
        print("\n⚠ Note: Actual tool names and parameters may vary.")
        print("  Adjust tests based on excel-mcp-server documentation.")
        print("  See: https://github.com/haris-musa/excel-mcp-server/blob/main/TOOLS.md")
        
        # Optional: Test write/read if you know the correct tool names
        # test_write_excel(tool, str(test_file))
        # if test_file.exists():
        #     test_read_excel(tool, str(test_file))
    
    print("\n" + "=" * 60)
    print("Test Suite Complete")
    print("=" * 60)
    
    # Cleanup
    tool.close()
    print("\n✓ Tool closed successfully")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())

