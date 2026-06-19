#!/usr/bin/env python3
"""Example usage of Excel MCP server for file manipulation."""

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from gem.tools.mcp_server.excel import create_excel_tool


def main():
    """Demonstrate Excel server capabilities with a real-world scenario."""
    print("=" * 70)
    print("Excel MCP Server - File Manipulation Example")
    print("=" * 70)
    print("\nScenario: Managing employee data with Excel\n")
    
    # Create tool
    try:
        tool = create_excel_tool(validate_on_init=True)
        print("✓ Excel tool initialized\n")
    except Exception as e:
        print(f"✗ Failed to initialize Excel tool: {e}")
        print("\nMake sure excel-mcp-server is installed:")
        print("  uv pip install excel-mcp-server")
        return 1
    
    # Get available tools
    print("Available tools:")
    print("-" * 70)
    tools = tool.get_available_tools()
    for t in tools:
        print(f"  - {t['name']}: {t['description'][:80]}...")
    print()
    
    # Step 1: Create employee data file
    print("Step 1: Creating employee data file...")
    print("-" * 70)
    
    # Note: Adjust the tool name and parameters based on actual excel-mcp-server API
    # This is a generic example that may need modification
    create_file = '''
<tool_call>
<tool_name>write_excel</tool_name>
<arguments>
{
  "file_path": "./example_employees.xlsx",
  "data": [
    ["Employee ID", "Name", "Department", "Salary", "Hire Date"],
    ["E001", "Alice Chen", "Engineering", 95000, "2020-01-15"],
    ["E002", "Bob Smith", "Engineering", 88000, "2021-03-22"],
    ["E003", "Carol Wang", "Data Science", 92000, "2019-06-10"],
    ["E004", "David Lee", "Marketing", 72000, "2022-01-05"],
    ["E005", "Emma Davis", "Sales", 78000, "2021-08-18"]
  ]
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(create_file)
        if is_valid and not has_error:
            print("✓ Successfully created employee data file")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
        print("  Actual tool names may differ. See:")
        print("  https://github.com/haris-musa/excel-mcp-server/blob/main/TOOLS.md")
    
    # Step 2: Read the file
    print("\nStep 2: Reading employee data...")
    print("-" * 70)
    
    read_file = '''
<tool_call>
<tool_name>read_excel</tool_name>
<arguments>
{
  "file_path": "./example_employees.xlsx"
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(read_file)
        if is_valid and not has_error:
            print("✓ Successfully read employee data")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 3: Format headers
    print("\nStep 3: Formatting header row...")
    print("-" * 70)
    
    format_headers = '''
<tool_call>
<tool_name>format_cell</tool_name>
<arguments>
{
  "file_path": "./example_employees.xlsx",
  "range": "A1:E1",
  "format": {
    "bold": true,
    "font_size": 12,
    "background_color": "#4472C4",
    "font_color": "#FFFFFF"
  }
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(format_headers)
        if is_valid and not has_error:
            print("✓ Successfully formatted headers")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 4: Add a new sheet for summary
    print("\nStep 4: Adding summary sheet...")
    print("-" * 70)
    
    add_sheet = '''
<tool_call>
<tool_name>add_sheet</tool_name>
<arguments>
{
  "file_path": "./example_employees.xlsx",
  "sheet_name": "Department Summary"
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(add_sheet)
        if is_valid and not has_error:
            print("✓ Successfully added summary sheet")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    # Step 5: Create a chart
    print("\nStep 5: Creating salary distribution chart...")
    print("-" * 70)
    
    create_chart = '''
<tool_call>
<tool_name>create_chart</tool_name>
<arguments>
{
  "file_path": "./example_employees.xlsx",
  "chart_type": "bar",
  "data_range": "A1:B6",
  "title": "Employee Salaries by Name"
}
</arguments>
</tool_call>
'''
    
    try:
        is_valid, has_error, obs, _ = tool.execute_action(create_chart)
        if is_valid and not has_error:
            print("✓ Successfully created chart")
            print(obs)
        else:
            print(f"⚠ Operation result: {obs}")
    except Exception as e:
        print(f"⚠ Note: {e}")
    
    print("\n" + "=" * 70)
    print("Example Complete")
    print("=" * 70)
    print("\nNote: This example uses generic tool names.")
    print("Actual tool names and parameters may differ.")
    print("Refer to the official documentation:")
    print("https://github.com/haris-musa/excel-mcp-server/blob/main/TOOLS.md")
    
    # Cleanup
    tool.close()
    print("\n✓ Tool closed successfully")
    
    # Optionally clean up the example file
    example_file = Path("./example_employees.xlsx")
    if example_file.exists():
        print(f"\n📄 Example file created: {example_file.absolute()}")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())

