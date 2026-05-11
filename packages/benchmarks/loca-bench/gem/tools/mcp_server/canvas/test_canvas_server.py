#!/usr/bin/env python
"""
Test script for Canvas MCP Server

This script tests the Canvas MCP server functionality.

Usage pattern is similar to Memory server:
  Canvas (HTTP):  tool = MCPTool.from_url("http://127.0.0.1:8082/canvas-mcp", validate_on_init=False)
  Memory (stdio): tool = create_memory_tool(validate_on_init=False)
"""

import sys
import os

# Add gem to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../../'))

import gem
from gem.tools.mcp_tool import MCPTool
from gem.tools.tool_env_wrapper import ToolEnvWrapper


def test_canvas_server():
    """Test Canvas MCP server with a simple environment"""
    
    print("=" * 60)
    print("Testing Canvas MCP Server")
    print("=" * 60)
    
    # Create MCP tool pointing to Canvas server
    canvas_url = "http://127.0.0.1:8082/canvas-mcp"
    print(f"\n1. Connecting to Canvas server at: {canvas_url}")
    
    try:
        tool = MCPTool.from_url(canvas_url, validate_on_init=False)
        print("   ✓ Connected successfully")
    except Exception as e:
        print(f"   ✗ Failed to connect: {e}")
        return
    
    # Get available tools
    print("\n2. Discovering available tools...")
    try:
        tools = tool.get_available_tools()
        print(f"   ✓ Found {len(tools)} tools:")
        for t in tools[:5]:  # Show first 5 tools
            print(f"      - {t['name']}: {t.get('description', 'No description')[:60]}...")
        if len(tools) > 5:
            print(f"      ... and {len(tools) - 5} more tools")
    except Exception as e:
        print(f"   ✗ Failed to discover tools: {e}")
        return
    
    # Create a simple test environment
    print("\n3. Creating test environment...")
    try:
        env = gem.make("game:GuessTheNumber-v0-easy", max_turns=3)
        env = ToolEnvWrapper(env, tools=[tool], max_tool_uses=5)
        obs, info = env.reset()
        print("   ✓ Environment created and reset")
    except Exception as e:
        print(f"   ✗ Failed to create environment: {e}")
        return
    
    # Test health check
    print("\n4. Testing canvas_health_check tool...")
    test_action = '<tool_call><tool_name>canvas_health_check</tool_name><arguments>{}</arguments></tool_call>'
    try:
        obs, reward, terminated, truncated, info = env.step(test_action)
        print(f"   ✓ Health check successful")
        print(f"   Response: {str(obs)[:200]}...")
    except Exception as e:
        print(f"   ✗ Health check failed: {e}")
    
    # Test listing courses (this might fail if not authenticated, which is expected)
    print("\n5. Testing canvas_list_courses tool...")
    test_action = '<tool_call><tool_name>canvas_list_courses</tool_name><arguments>{}</arguments></tool_call>'
    try:
        obs, reward, terminated, truncated, info = env.step(test_action)
        if "not authenticated" in str(obs).lower() or "error" in str(obs).lower():
            print(f"   ⚠ Authentication required (expected): {str(obs)[:100]}...")
        else:
            print(f"   ✓ List courses successful")
            print(f"   Response: {str(obs)[:200]}...")
    except Exception as e:
        print(f"   ⚠ Expected error (authentication required): {e}")
    
    print("\n" + "=" * 60)
    print("Canvas MCP Server Test Complete!")
    print("=" * 60)
    print("\nNote: Some tests may fail due to authentication requirements.")
    print("This is expected behavior for a secure Canvas server.")


if __name__ == "__main__":
    test_canvas_server()
