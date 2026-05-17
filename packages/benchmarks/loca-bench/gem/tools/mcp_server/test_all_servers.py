#!/usr/bin/env python
"""
Test script for all MCP Servers (Canvas, Memory, etc.)

This script demonstrates how to use different MCP servers with consistent syntax.
"""

import sys
import os

# Add gem to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../'))

import gem
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.memory import create_memory_tool
from gem.tools.tool_env_wrapper import ToolEnvWrapper


def test_canvas_server():
    """Test Canvas MCP server (HTTP-based)"""
    
    print("\n" + "=" * 60)
    print("Testing Canvas MCP Server (HTTP)")
    print("=" * 60)
    
    # Canvas uses HTTP, so we use from_url
    canvas_url = "http://127.0.0.1:8082/canvas-mcp"
    print(f"\nConnecting to Canvas server at: {canvas_url}")
    
    try:
        tool = MCPTool.from_url(canvas_url, validate_on_init=False)
        print("✓ Connected successfully")
        
        # Get available tools
        tools = tool.get_available_tools()
        print(f"✓ Found {len(tools)} tools")
        print(f"  Sample tools: {', '.join([t['name'] for t in tools[:3]])}")
        
        # Test health check
        action = '<tool_call><tool_name>canvas_health_check</tool_name><arguments>{}</arguments></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        print(f"✓ Health check: {'Success' if not has_error else 'Failed'}")
        
        return True
    except Exception as e:
        print(f"✗ Canvas test failed: {e}")
        return False


def test_memory_server():
    """Test Memory MCP server (stdio-based)"""
    
    print("\n" + "=" * 60)
    print("Testing Memory MCP Server (stdio)")
    print("=" * 60)
    
    # Memory uses stdio, so we use create_memory_tool
    print("\nCreating Memory server...")
    
    try:
        tool = create_memory_tool(
            memory_file_path="./test_memory.json",
            validate_on_init=False  # Fast startup like Canvas
        )
        print("✓ Created successfully")
        
        # Get available tools
        tools = tool.get_available_tools()
        print(f"✓ Found {len(tools)} tools")
        print(f"  Sample tools: {', '.join([t['name'] for t in tools[:3]])}")
        
        # Test creating an entity
        action = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Test Entity",
      "entityType": "test",
      "observations": ["This is a test"]
    }
  ]
}
</arguments>
</tool_call>
'''
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        print(f"✓ Create entity: {'Success' if not has_error else 'Failed'}")
        
        # Clean up
        tool.close()
        
        # Remove test file
        import os
        if os.path.exists("./test_memory.json"):
            os.remove("./test_memory.json")
        
        return True
    except Exception as e:
        print(f"✗ Memory test failed: {e}")
        return False


def test_with_environment():
    """Test both servers with a GEM environment"""
    
    print("\n" + "=" * 60)
    print("Testing with GEM Environment")
    print("=" * 60)
    
    try:
        # Create Memory tool (Canvas would need to be running)
        print("\nCreating Memory tool for environment integration...")
        memory_tool = create_memory_tool(
            memory_file_path="./env_test_memory.json",
            validate_on_init=False
        )
        print("✓ Memory tool created")
        
        # Create environment with Memory tool
        print("\nCreating GuessTheNumber environment with Memory tool...")
        env = gem.make("game:GuessTheNumber-v0-easy", max_turns=3)
        env = ToolEnvWrapper(env, tools=[memory_tool], max_tool_uses=5)
        obs, info = env.reset()
        print("✓ Environment created and reset")
        
        # Test using the tool in environment
        print("\nTesting tool execution in environment...")
        action = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Game Session",
      "entityType": "session",
      "observations": ["Started GuessTheNumber game"]
    }
  ]
}
</arguments>
</tool_call>
'''
        obs, reward, terminated, truncated, info = env.step(action)
        print("✓ Tool executed in environment")
        
        # Clean up
        memory_tool.close()
        import os
        if os.path.exists("./env_test_memory.json"):
            os.remove("./env_test_memory.json")
        
        return True
    except Exception as e:
        print(f"✗ Environment test failed: {e}")
        return False


def show_usage_comparison():
    """Show side-by-side usage comparison"""
    
    print("\n" + "=" * 60)
    print("Usage Comparison")
    print("=" * 60)
    
    print("\n# Canvas Server (HTTP-based):")
    print("─" * 60)
    print("""
from gem.tools.mcp_tool import MCPTool

# Method 1: Direct URL
tool = MCPTool("http://127.0.0.1:8082/canvas-mcp")

# Method 2: With validation disabled (faster)
tool = MCPTool.from_url(
    "http://127.0.0.1:8082/canvas-mcp",
    validate_on_init=False
)
""")
    
    print("\n# Memory Server (stdio-based):")
    print("─" * 60)
    print("""
from gem.tools.mcp_server.memory import create_memory_tool

# Method 1: Simple creation
tool = create_memory_tool()

# Method 2: With custom path and no validation (faster)
tool = create_memory_tool(
    memory_file_path="./my_memory.json",
    validate_on_init=False
)
""")
    
    print("\n# Both servers share the same interface:")
    print("─" * 60)
    print("""
# Get tools
tools = tool.get_available_tools()

# Execute action
action = '<tool_call><tool_name>name</tool_name><arguments>...</arguments></tool_call>'
is_valid, has_error, observation, parsed = tool.execute_action(action)

# Use with GEM environment
env = ToolEnvWrapper(base_env, tools=[tool])
""")


def main():
    """Run all tests"""
    
    print("=" * 60)
    print("MCP Servers Test Suite")
    print("=" * 60)
    print("\nThis script tests Canvas (HTTP) and Memory (stdio) servers")
    print("with consistent usage patterns.\n")
    
    results = {}
    
    # Show usage comparison first
    show_usage_comparison()
    
    # Test Memory (doesn't require server to be running)
    results['Memory'] = test_memory_server()
    
    # Test Canvas (requires server to be running)
    print("\nNote: Canvas server must be running at http://127.0.0.1:8082")
    print("Start it with: cd canvas && python server.py")
    
    user_input = input("\nIs Canvas server running? (y/n): ").strip().lower()
    if user_input == 'y':
        results['Canvas'] = test_canvas_server()
    else:
        print("Skipping Canvas server tests")
        results['Canvas'] = None
    
    # Test environment integration
    results['Environment'] = test_with_environment()
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    for name, result in results.items():
        if result is None:
            status = "⊘ SKIPPED"
        elif result:
            status = "✓ PASS"
        else:
            status = "✗ FAIL"
        print(f"{status}: {name}")
    
    passed = sum(1 for r in results.values() if r is True)
    total = sum(1 for r in results.values() if r is not None)
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n✓ All tests passed!")
        return 0
    else:
        print(f"\n⚠ Some tests failed or were skipped")
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(1)
