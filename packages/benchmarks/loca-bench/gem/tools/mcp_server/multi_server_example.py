#!/usr/bin/env python3
"""
Multi-Server Example: Using Canvas and Memory together

This example shows three different ways to use multiple MCP servers together.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../'))

import gem
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.memory import create_memory_tool
from gem.tools.tool_env_wrapper import ToolEnvWrapper


def method_1_separate_tools():
    """
    Method 1: Create separate tools and use them in ToolEnvWrapper
    
    This is the simplest and most flexible approach.
    Each tool is independent and can be configured separately.
    """
    print("\n" + "=" * 70)
    print("Method 1: Separate Tools (Recommended)")
    print("=" * 70)
    
    print("""
# Create each tool separately
canvas_tool = MCPTool.from_url(
    "http://127.0.0.1:8082/canvas-mcp",
    validate_on_init=False
)

memory_tool = create_memory_tool(
    memory_file_path="./memory.json",
    validate_on_init=False
)

# Use them together in environment
env = gem.make("math:GSM8K")
wrapped_env = ToolEnvWrapper(
    env,
    tools=[canvas_tool, memory_tool],  # Pass both tools as list
    max_tool_uses=20
)

# All tools from both servers are available
obs, info = wrapped_env.reset()
obs, reward, terminated, truncated, info = wrapped_env.step(action)

# Clean up
canvas_tool.close()
memory_tool.close()
    """)
    
    print("\n✓ Advantages:")
    print("  - Simple and intuitive")
    print("  - Each tool can have different configurations")
    print("  - Easy to add/remove servers")
    print("  - Tools have unprefixed names")


def method_2_single_mcp_tool():
    """
    Method 2: Single MCPTool with multi-server configuration
    
    This creates one MCPTool instance that manages multiple servers.
    Tool names will be prefixed (canvas_*, memory_*).
    """
    print("\n" + "=" * 70)
    print("Method 2: Single Multi-Server MCPTool")
    print("=" * 70)
    
    print("""
# Configure multiple servers in one config
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

# Create single tool with both servers
tool = MCPTool(config, validate_on_init=False)

# Use in environment
env = gem.make("math:GSM8K")
wrapped_env = ToolEnvWrapper(env, tools=[tool])

# Tools are prefixed by server name:
# - canvas_health_check
# - canvas_list_courses
# - memory_create_entities
# - memory_search_nodes

obs, info = wrapped_env.reset()
tool.close()
    """)
    
    print("\n✓ Advantages:")
    print("  - Single tool to manage")
    print("  - Unified configuration")
    print("  - Clear server origin (prefixed names)")
    print("\n⚠ Note:")
    print("  - Tool names are prefixed (canvas_*, memory_*)")


def method_3_helper_function():
    """
    Method 3: Create a helper function for common multi-server setups
    """
    print("\n" + "=" * 70)
    print("Method 3: Custom Helper Function")
    print("=" * 70)
    
    print("""
# Create a reusable helper
def create_canvas_and_memory_tools(
    canvas_url="http://127.0.0.1:8082/canvas-mcp",
    memory_file="./memory.json"
):
    canvas = MCPTool.from_url(canvas_url, validate_on_init=False)
    memory = create_memory_tool(memory_file, validate_on_init=False)
    return canvas, memory

# Use it
canvas_tool, memory_tool = create_canvas_and_memory_tools()

env = gem.make("math:GSM8K")
wrapped_env = ToolEnvWrapper(env, tools=[canvas_tool, memory_tool])

# Clean up both
for tool in [canvas_tool, memory_tool]:
    tool.close()
    """)
    
    print("\n✓ Advantages:")
    print("  - Reusable across projects")
    print("  - Consistent configuration")
    print("  - Easy to extend")


def show_real_example():
    """Show a real working example"""
    print("\n" + "=" * 70)
    print("Real Working Example")
    print("=" * 70)
    
    print("\n# Scenario: Student using Canvas LMS with Memory for notes")
    print("-" * 70)
    
    try:
        # Create both tools
        print("\n1. Creating tools...")
        
        # Canvas tool (HTTP-based, requires server running)
        canvas_url = "http://127.0.0.1:8082/canvas-mcp"
        print(f"   - Canvas: {canvas_url}")
        
        # Memory tool (stdio-based, auto-starts)
        memory_file = "./example_memory.json"
        print(f"   - Memory: {memory_file}")
        
        memory_tool = create_memory_tool(
            memory_file_path=memory_file,
            validate_on_init=False
        )
        print("   ✓ Memory tool created")
        
        # Get tools from memory to verify it works
        memory_tools = memory_tool.get_available_tools()
        print(f"   ✓ Memory has {len(memory_tools)} tools")
        
        # Create a test environment
        print("\n2. Creating environment with Memory tool...")
        env = gem.make("game:GuessTheNumber-v0-easy", max_turns=5)
        wrapped_env = ToolEnvWrapper(env, tools=[memory_tool], max_tool_uses=3)
        obs, info = wrapped_env.reset()
        print("   ✓ Environment created")
        
        # Test Memory tool
        print("\n3. Testing Memory tool...")
        action = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [
    {
      "name": "Study Session",
      "entityType": "event",
      "observations": [
        "Started studying at 10:00 AM",
        "Working on Math homework"
      ]
    }
  ]
}
</arguments>
</tool_call>
'''
        obs, reward, terminated, truncated, info = wrapped_env.step(action)
        print(f"   ✓ Memory tool executed")
        print(f"   Result: {str(obs)[:100]}...")
        
        # Clean up
        memory_tool.close()
        if os.path.exists(memory_file):
            os.remove(memory_file)
        
        print("\n4. Summary:")
        print("   ✓ Memory tool works independently")
        print("   ✓ Can be combined with Canvas when both are available")
        print("   ✓ Both use the same interface")
        
        return True
        
    except Exception as e:
        print(f"\n   ✗ Example failed: {e}")
        print("\n   Note: Canvas server must be running for full demo")
        print("   Start with: cd canvas && python server.py")
        return False


def show_use_cases():
    """Show common use cases for combining servers"""
    print("\n" + "=" * 70)
    print("Common Use Cases")
    print("=" * 70)
    
    print("\n1. Student Learning Assistant:")
    print("   - Canvas: Access courses, assignments, submissions")
    print("   - Memory: Store study notes, relationships between concepts")
    
    print("\n2. Educational Agent:")
    print("   - Canvas: Manage course content and grades")
    print("   - Memory: Track student progress and learning patterns")
    
    print("\n3. Research Assistant:")
    print("   - Canvas: Organize course materials")
    print("   - Memory: Build knowledge graph of research topics")
    
    print("\n4. Homework Helper:")
    print("   - Canvas: Get assignment details and due dates")
    print("   - Memory: Remember solved problems and strategies")


def main():
    """Main demonstration"""
    print("=" * 70)
    print("Multi-Server Example: Canvas + Memory")
    print("=" * 70)
    
    print("\nThis example shows how to use Canvas and Memory servers together.")
    print("There are multiple approaches depending on your needs:")
    
    # Show all methods
    method_1_separate_tools()
    method_2_single_mcp_tool()
    method_3_helper_function()
    
    # Show use cases
    show_use_cases()
    
    # Run real example
    print("\n" + "=" * 70)
    print("Running Real Example")
    print("=" * 70)
    show_real_example()
    
    # Recommendation
    print("\n" + "=" * 70)
    print("Recommendation")
    print("=" * 70)
    print("""
For most use cases, we recommend Method 1 (Separate Tools):

canvas_tool = MCPTool.from_url("http://127.0.0.1:8082/canvas-mcp", validate_on_init=False)
memory_tool = create_memory_tool(validate_on_init=False)

wrapped_env = ToolEnvWrapper(env, tools=[canvas_tool, memory_tool])

This gives you:
✓ Maximum flexibility
✓ Independent configuration
✓ Clean tool names
✓ Easy debugging
    """)
    
    print("\n" + "=" * 70)
    print("Complete Example Code")
    print("=" * 70)
    print("""
#!/usr/bin/env python3
import gem
from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.memory import create_memory_tool
from gem.tools.tool_env_wrapper import ToolEnvWrapper

# 1. Create both tools
canvas_tool = MCPTool.from_url(
    "http://127.0.0.1:8082/canvas-mcp",
    validate_on_init=False
)
memory_tool = create_memory_tool(
    memory_file_path="./session_memory.json",
    validate_on_init=False
)

# 2. Create environment with both tools
env = gem.make("math:GSM8K")
wrapped_env = ToolEnvWrapper(
    env,
    tools=[canvas_tool, memory_tool],
    max_tool_uses=20
)

# 3. Use the environment
obs, info = wrapped_env.reset()

# Agent can now use both Canvas and Memory tools
# Canvas tools: canvas_list_courses, canvas_get_assignment, etc.
# Memory tools: create_entities, search_nodes, read_graph, etc.

action = '<tool_call>...</tool_call>'
obs, reward, terminated, truncated, info = wrapped_env.step(action)

# 4. Clean up
canvas_tool.close()
memory_tool.close()
    """)


if __name__ == "__main__":
    main()
