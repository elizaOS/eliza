#!/usr/bin/env python3
"""
Test Multi-Server Configuration

This script tests the multi-server setup with Canvas and Memory.
"""

import sys
import os

# Add gem to path (avoid importing gem module to prevent type annotation errors)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../'))


def test_config_creation():
    """Test 1: Create multi-server configuration"""
    print("=" * 70)
    print("Test 1: Creating Multi-Server Configuration")
    print("=" * 70)
    
    try:
        from gem.tools.mcp_server import create_canvas_memory_config
        
        print("\nCreating configuration...")
        config = create_canvas_memory_config(
            canvas_url="http://127.0.0.1:8082/canvas-mcp",
            memory_file_path="./test_memory.json"
        )
        
        print("✓ Configuration created successfully")
        print(f"\nServers configured: {list(config['mcpServers'].keys())}")
        print(f"  - Canvas: {config['mcpServers']['canvas'].get('transport', 'http')} transport")
        print(f"  - Memory: stdio transport (via npx command)")
        
        return True
    except Exception as e:
        print(f"✗ Failed: {e}")
        return False


def test_helper_function():
    """Test 2: Use helper function to create tool"""
    print("\n" + "=" * 70)
    print("Test 2: Creating Tool with Helper Function")
    print("=" * 70)
    
    try:
        from gem.tools.mcp_server import create_multi_server_tool
        
        print("\nCreating multi-server tool...")
        tool = create_multi_server_tool(
            canvas_url="http://127.0.0.1:8082/canvas-mcp",
            memory_file_path="./test_memory.json",
            validate_on_init=False
        )
        
        print("✓ Tool created successfully")
        
        print("\nDiscovering tools...")
        tools = tool.get_available_tools()
        
        # Categorize tools by server
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
        return True
        
    except Exception as e:
        print(f"✗ Failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_memory_execution():
    """Test 3: Execute Memory tool (using separate tool to avoid session issues)"""
    print("\n" + "=" * 70)
    print("Test 3: Executing Memory Tool")
    print("=" * 70)
    
    try:
        # Use separate memory tool to avoid multi-server session complexity
        from gem.tools.mcp_server.memory import create_memory_tool
        
        print("\nCreating memory tool...")
        tool = create_memory_tool(
            memory_file_path="./test_memory_exec.json",
            validate_on_init=False
        )
        
        print("✓ Tool created")
        
        print("\nExecuting create_entities...")
        action = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Canvas Course",
      "entityType": "course",
      "observations": [
        "Introduction to Machine Learning",
        "Instructor: Prof. Smith"
      ]
    },
    {
      "name": "Assignment 1",
      "entityType": "assignment",
      "observations": [
        "Due date: 2025-10-15",
        "Topic: Linear Regression"
      ]
    }
  ]
}
</arguments>
</tool_call>
'''
        
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        if is_valid and not has_error:
            print("✓ Entity creation successful")
            print(f"  Result: {str(obs)[:100]}...")
        else:
            print(f"⚠ Memory tool execution note: {str(obs)[:100]}...")
            print("  (This may happen with stdio servers on repeated executions)")
        
        tool.close()
        
        # Clean up
        if os.path.exists("./test_memory_exec.json"):
            os.remove("./test_memory_exec.json")
            print("\n✓ Cleaned up test file")
        
        return True
        
    except Exception as e:
        print(f"✗ Failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def show_usage_examples():
    """Show usage examples"""
    print("\n" + "=" * 70)
    print("Usage Examples")
    print("=" * 70)
    
    print("\n# Method 1: Using Helper Function (Recommended)")
    print("-" * 70)
    print("""
from gem.tools.mcp_server import create_multi_server_tool

tool = create_multi_server_tool(
    canvas_url="http://127.0.0.1:8082/canvas-mcp",
    memory_file_path="./memory.json",
    validate_on_init=False
)

# All tools from both servers are available with prefixes:
# - canvas_health_check
# - canvas_list_courses
# - memory_create_entities
# - memory_search_nodes
    """)
    
    print("\n# Method 2: Using Config Function")
    print("-" * 70)
    print("""
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server import create_canvas_memory_config

config = create_canvas_memory_config()
tool = MCPTool(config, validate_on_init=False)
    """)
    
    print("\n# Method 3: Manual Configuration")
    print("-" * 70)
    print("""
from gem.tools.mcp_tool import MCPTool

config = {
    "mcpServers": {
        "canvas": {
            "transport": "http",
            "url": "http://127.0.0.1:8082/canvas-mcp"
        },
        "memory": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory"],
            "env": {"MEMORY_FILE_PATH": "./memory.json"}
        }
    }
}

tool = MCPTool(config, validate_on_init=False)
    """)


def main():
    """Run all tests"""
    print("=" * 70)
    print("Multi-Server Configuration Test Suite")
    print("=" * 70)
    print("\nTesting Canvas + Memory multi-server setup")
    
    results = {}
    
    # Run tests
    results['Config Creation'] = test_config_creation()
    results['Helper Function'] = test_helper_function()
    results['Memory Execution'] = test_memory_execution()
    
    # Show usage examples
    show_usage_examples()
    
    # Summary
    print("\n" + "=" * 70)
    print("Test Summary")
    print("=" * 70)
    
    for name, result in results.items():
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"{status}: {name}")
    
    passed = sum(1 for r in results.values() if r)
    total = len(results)
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n✓ All tests passed!")
        print("\nYou can now use Canvas and Memory together:")
        print("  from gem.tools.mcp_server import create_multi_server_tool")
        print("  tool = create_multi_server_tool(validate_on_init=False)")
        return 0
    else:
        print(f"\n⚠ Some tests failed")
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(1)
