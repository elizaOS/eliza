#!/usr/bin/env python3
"""
Simple Multi-Server Example

Shows the easiest way to use Canvas and Memory together with a single MCPTool.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../'))


def example_1_using_helper():
    """Example 1: Using the helper function (Easiest!)"""
    print("=" * 70)
    print("Example 1: Using Helper Function (Recommended)")
    print("=" * 70)
    
    print("\nCode:")
    print("-" * 70)
    print("""
from gem.tools.mcp_server import create_multi_server_tool

# Create tool with both Canvas and Memory servers
tool = create_multi_server_tool(
    canvas_url="http://127.0.0.1:8082/canvas-mcp",
    memory_file_path="./memory.json",
    validate_on_init=False
)

# Get all tools from both servers
tools = tool.get_available_tools()

# Tools are prefixed by server name:
# - canvas_health_check
# - canvas_list_courses
# - canvas_get_assignment
# - memory_create_entities
# - memory_search_nodes
# - memory_read_graph

# Execute Canvas tool
action1 = '<tool_call><tool_name>canvas_health_check</tool_name><arguments>{}</arguments></tool_call>'
is_valid, has_error, obs, parsed = tool.execute_action(action1)

# Execute Memory tool
action2 = '<tool_call><tool_name>memory_create_entities</tool_name><arguments>...</arguments></tool_call>'
is_valid, has_error, obs, parsed = tool.execute_action(action2)

tool.close()
    """)


def example_2_using_config():
    """Example 2: Using the config function"""
    print("\n" + "=" * 70)
    print("Example 2: Using Config Function")
    print("=" * 70)
    
    print("\nCode:")
    print("-" * 70)
    print("""
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server import create_canvas_memory_config

# Create the configuration
config = create_canvas_memory_config(
    canvas_url="http://127.0.0.1:8082/canvas-mcp",
    memory_file_path="./memory.json"
)

# Create tool with the config
tool = MCPTool(config, validate_on_init=False)

# Use the tool (same as Example 1)
tools = tool.get_available_tools()
tool.execute_action(action)

tool.close()
    """)


def example_3_manual_config():
    """Example 3: Manual configuration"""
    print("\n" + "=" * 70)
    print("Example 3: Manual Configuration (Most Flexible)")
    print("=" * 70)
    
    print("\nCode:")
    print("-" * 70)
    print("""
from gem.tools.mcp_tool import MCPTool

# Manually create the configuration
config = {
    "mcpServers": {
        "canvas": {
            "transport": "http",
            "url": "http://127.0.0.1:8082/canvas-mcp"
        },
        "memory": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory"],
            "env": {
                "MEMORY_FILE_PATH": "./memory.json"
            }
        }
    }
}

# Create tool
tool = MCPTool(config, validate_on_init=False)

# Use the tool
tools = tool.get_available_tools()

tool.close()
    """)


def example_4_with_environment():
    """Example 4: Using with GEM environment"""
    print("\n" + "=" * 70)
    print("Example 4: With GEM Environment")
    print("=" * 70)
    
    print("\nCode:")
    print("-" * 70)
    print("""
import gem
from gem.tools.mcp_server import create_multi_server_tool
from gem.tools.tool_env_wrapper import ToolEnvWrapper

# Create multi-server tool
tool = create_multi_server_tool(validate_on_init=False)

# Create environment with the tool
env = gem.make("math:GSM8K")
wrapped_env = ToolEnvWrapper(env, tools=[tool], max_tool_uses=20)

# Use the environment
obs, info = wrapped_env.reset()

# Agent can now use both Canvas and Memory tools
action = '<tool_call><tool_name>canvas_list_courses</tool_name>...</tool_call>'
obs, reward, terminated, truncated, info = wrapped_env.step(action)

action = '<tool_call><tool_name>memory_create_entities</tool_name>...</tool_call>'
obs, reward, terminated, truncated, info = wrapped_env.step(action)

tool.close()
    """)


def real_test():
    """Run a real test with Memory server"""
    print("\n" + "=" * 70)
    print("Real Test: Memory Server Only")
    print("=" * 70)
    print("\n(Canvas requires server to be running, so testing Memory only)")
    
    try:
        from gem.tools.mcp_server import create_multi_server_tool
        
        print("\nCreating multi-server tool...")
        tool = create_multi_server_tool(
            memory_file_path="./test_multi.json",
            validate_on_init=False
        )
        print("✓ Tool created")
        
        print("\nDiscovering tools...")
        tools = tool.get_available_tools()
        print(f"✓ Found {len(tools)} tools total")
        
        # Count by server
        canvas_tools = [t for t in tools if t['name'].startswith('canvas_')]
        memory_tools = [t for t in tools if t['name'].startswith('memory_')]
        
        print(f"  - Canvas tools: {len(canvas_tools)}")
        print(f"  - Memory tools: {len(memory_tools)}")
        
        if memory_tools:
            print(f"\nSample Memory tools:")
            for t in memory_tools[:3]:
                print(f"  - {t['name']}")
        
        if canvas_tools:
            print(f"\nSample Canvas tools:")
            for t in canvas_tools[:3]:
                print(f"  - {t['name']}")
        
        # Test Memory tool
        print("\nTesting memory_create_entities...")
        action = '''
<tool_call>
<tool_name>memory_create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Multi-Server Test",
      "entityType": "test",
      "observations": ["Testing Canvas and Memory together"]
    }
  ]
}
</arguments>
</tool_call>
'''
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        if not has_error:
            print("✓ Memory tool executed successfully")
            print(f"  Result: {str(obs)[:100]}...")
        else:
            print(f"✗ Memory tool failed: {obs}")
        
        tool.close()
        
        # Clean up test file
        if os.path.exists("./test_multi.json"):
            os.remove("./test_multi.json")
        
        print("\n✓ Test completed successfully!")
        return True
        
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def comparison():
    """Show comparison of approaches"""
    print("\n" + "=" * 70)
    print("Comparison: Separate vs Multi-Server")
    print("=" * 70)
    
    print("\n" + "Approach 1: Separate Tools".center(70))
    print("-" * 70)
    print("""
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.memory import create_memory_tool

canvas = MCPTool.from_url("http://127.0.0.1:8082/canvas-mcp", validate_on_init=False)
memory = create_memory_tool(validate_on_init=False)

wrapped_env = ToolEnvWrapper(env, tools=[canvas, memory])

✓ Tool names: canvas_health_check, create_entities (no prefix)
✓ Easy to add/remove servers
✓ Independent configuration
    """)
    
    print("\n" + "Approach 2: Multi-Server Tool".center(70))
    print("-" * 70)
    print("""
from gem.tools.mcp_server import create_multi_server_tool

tool = create_multi_server_tool(validate_on_init=False)

wrapped_env = ToolEnvWrapper(env, tools=[tool])

✓ Tool names: canvas_health_check, memory_create_entities (prefixed)
✓ Single tool to manage
✓ Unified configuration
✓ Clear server origin
    """)


def main():
    """Main demonstration"""
    print("=" * 70)
    print("Multi-Server Configuration: Canvas + Memory")
    print("=" * 70)
    print("\nUsing a single MCPTool with multiple servers")
    
    # Show all examples
    example_1_using_helper()
    example_2_using_config()
    example_3_manual_config()
    example_4_with_environment()
    
    # Show comparison
    comparison()
    
    # Run real test
    real_test()
    
    # Summary
    print("\n" + "=" * 70)
    print("Summary")
    print("=" * 70)
    print("""
To use Canvas and Memory together with multi-server config:

Method 1 (Easiest):
    from gem.tools.mcp_server import create_multi_server_tool
    tool = create_multi_server_tool(validate_on_init=False)

Method 2 (More control):
    from gem.tools.mcp_server import create_canvas_memory_config
    config = create_canvas_memory_config()
    tool = MCPTool(config, validate_on_init=False)

Both give you a single tool with access to all Canvas and Memory functions!
    """)


if __name__ == "__main__":
    main()
