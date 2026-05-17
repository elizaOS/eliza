#!/usr/bin/env python3
"""
stdio Modes Example - Auto-Starting Servers

This example shows how to use Canvas and Memory WITHOUT manually starting servers!
Both servers auto-start via stdio transport.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../'))


def example_canvas_http_mode():
    """Traditional: Canvas HTTP mode (requires manual server start)"""
    print("=" * 70)
    print("Mode 1: Canvas HTTP + Memory stdio")
    print("=" * 70)
    print("\n❌ Requires manual setup:")
    print("   1. Start Canvas server: cd canvas && python server.py")
    print("   2. Then create tool")
    print("\nCode:")
    print("-" * 70)
    print("""
from gem.tools.mcp_server import create_multi_server_tool

# Canvas via HTTP (manual start), Memory via stdio (auto-start)
tool = create_multi_server_tool(
    canvas_url="http://127.0.0.1:8082/canvas-mcp",
    memory_file_path="./memory.json",
    validate_on_init=False
)

# Works, but Canvas must be running first
    """)


def example_canvas_stdio_mode():
    """New: Canvas stdio mode (auto-starts!)"""
    print("\n" + "=" * 70)
    print("Mode 2: Canvas stdio + Memory stdio (Both Auto-Start!)")
    print("=" * 70)
    print("\n✅ No manual setup needed:")
    print("   Both servers auto-start automatically!")
    print("\nCode:")
    print("-" * 70)
    print("""
from gem.tools.mcp_server import create_multi_server_tool_stdio

# Both Canvas and Memory auto-start!
tool = create_multi_server_tool_stdio(
    canvas_data_dir="./canvas_data",
    canvas_login_id="student1",  # Optional auto-login
    canvas_password="password123",
    memory_file_path="./memory.json",
    validate_on_init=False
)

# Both servers started automatically, ready to use!
tools = tool.get_available_tools()
# canvas_health_check, canvas_list_courses, ...
# memory_create_entities, memory_search_nodes, ...
    """)


def example_individual_canvas_modes():
    """Using Canvas individually in different modes"""
    print("\n" + "=" * 70)
    print("Individual Canvas Tool Modes")
    print("=" * 70)
    
    print("\n# HTTP Mode (FastMCP server, manual start)")
    print("-" * 70)
    print("""
from gem.tools.mcp_server.canvas import create_canvas_tool_http

# Start server first: cd canvas && python server.py
tool = create_canvas_tool_http(validate_on_init=False)
    """)
    
    print("\n# stdio Mode (original server, auto-start)")
    print("-" * 70)
    print("""
from gem.tools.mcp_server.canvas import create_canvas_tool_stdio

# Auto-starts - no manual server needed!
tool = create_canvas_tool_stdio(
    data_dir="./canvas_data",
    login_id="student1",
    password="password123",
    validate_on_init=False
)
    """)


def comparison_table():
    """Show comparison between modes"""
    print("\n" + "=" * 70)
    print("Comparison Table")
    print("=" * 70)
    
    print("\n{:<20} {:<25} {:<25}".format("Feature", "HTTP Mode", "stdio Mode"))
    print("-" * 70)
    
    rows = [
        ("Manual Start", "Yes (HTTP server)", "No (auto-starts)"),
        ("Server Type", "FastMCP (new)", "Original Canvas"),
        ("Tool Count", "67 tools", "67 tools (same)"),
        ("Tool Names", "No prefix", "canvas_* prefix"),
        ("Use Case", "Production, web API", "Testing, scripts"),
        ("Setup Time", "Slower (manual)", "Faster (automatic)"),
        ("Dependencies", "python server.py", "uv + Python"),
    ]
    
    for feature, http_mode, stdio_mode in rows:
        print("{:<20} {:<25} {:<25}".format(feature, http_mode, stdio_mode))


def real_test_stdio():
    """Test the stdio mode"""
    print("\n" + "=" * 70)
    print("Real Test: stdio Mode (Auto-Start)")
    print("=" * 70)
    
    try:
        from gem.tools.mcp_server import create_multi_server_tool_stdio
        
        print("\nCreating tool with both servers in stdio mode...")
        print("(This will auto-start both Canvas and Memory)")
        
        tool = create_multi_server_tool_stdio(
            canvas_data_dir="./test_canvas_stdio",
            memory_file_path="./test_memory_stdio.json",
            validate_on_init=False
        )
        
        print("✓ Tool created (both servers auto-started!)")
        
        print("\nDiscovering tools...")
        tools = tool.get_available_tools()
        
        canvas_tools = [t for t in tools if t['name'].startswith('canvas_')]
        memory_tools = [t for t in tools if t['name'].startswith('memory_')]
        
        print(f"✓ Found {len(tools)} tools total:")
        print(f"  - Canvas tools: {len(canvas_tools)}")
        print(f"  - Memory tools: {len(memory_tools)}")
        
        if canvas_tools:
            print(f"\n  Sample Canvas tools:")
            for t in canvas_tools[:3]:
                print(f"    • {t['name']}")
        
        if memory_tools:
            print(f"\n  Sample Memory tools:")
            for t in memory_tools[:3]:
                print(f"    • {t['name']}")
        
        tool.close()
        
        # Clean up
        import shutil
        if os.path.exists("./test_canvas_stdio"):
            shutil.rmtree("./test_canvas_stdio")
        if os.path.exists("./test_memory_stdio.json"):
            os.remove("./test_memory_stdio.json")
        
        print("\n✓ Test completed successfully!")
        return True
        
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        print("\nNote: This requires:")
        print("  - 'uv' command available")
        print("  - mcp_convert/mcps/canvas/server.py accessible")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Main demonstration"""
    print("=" * 70)
    print("stdio Modes - Auto-Starting Servers")
    print("=" * 70)
    print("\nNow you can use Canvas without manually starting the HTTP server!")
    
    # Show examples
    example_canvas_http_mode()
    example_canvas_stdio_mode()
    example_individual_canvas_modes()
    comparison_table()
    
    # Test it
    print("\n" + "=" * 70)
    print("Running Real Test")
    print("=" * 70)
    real_test_stdio()
    
    # Summary
    print("\n" + "=" * 70)
    print("Summary")
    print("=" * 70)
    print("""
🎉 Three ways to use Canvas + Memory:

1. HTTP Mode (Traditional):
   from gem.tools.mcp_server import create_multi_server_tool
   tool = create_multi_server_tool()  # Canvas manual, Memory auto

2. stdio Mode (New - Easiest!):
   from gem.tools.mcp_server import create_multi_server_tool_stdio
   tool = create_multi_server_tool_stdio()  # Both auto-start!

3. Separate Tools:
   from gem.tools.mcp_server.canvas import create_canvas_tool_stdio
   from gem.tools.mcp_server.memory import create_memory_tool
   canvas = create_canvas_tool_stdio()  # Auto-starts
   memory = create_memory_tool()  # Auto-starts

Recommendation: Use stdio mode for development and testing!
    """)


if __name__ == "__main__":
    main()
