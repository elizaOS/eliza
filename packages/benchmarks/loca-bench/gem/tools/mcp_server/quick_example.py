#!/usr/bin/env python3
"""
Quick example showing consistent usage pattern for all MCP servers.

Both Canvas (HTTP) and Memory (stdio) servers now use similar, clean syntax!
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../'))


def show_canvas_usage():
    """Canvas Server - HTTP-based"""
    print("\n" + "=" * 70)
    print("Canvas Server (HTTP) - Must start server first")
    print("=" * 70)
    
    print("\n# Start server in terminal:")
    print("cd gem/tools/mcp_server/canvas")
    print("python server.py --transport streamable-http --port 8082")
    
    print("\n# Use in Python:")
    print("-" * 70)
    print("""
from gem.tools.mcp_tool import MCPTool

# Create Canvas tool
canvas_tool = MCPTool.from_url(
    "http://127.0.0.1:8082/canvas-mcp",
    validate_on_init=False  # Fast startup
)

# Get available tools
tools = canvas_tool.get_available_tools()
print(f"Found {len(tools)} Canvas tools")

# Execute action
action = '''
<tool_call>
<tool_name>canvas_health_check</tool_name>
<arguments>{}</arguments>
</tool_call>
'''

is_valid, has_error, obs, parsed = canvas_tool.execute_action(action)
print(obs)
""")


def show_memory_usage():
    """Memory Server - stdio-based"""
    print("\n" + "=" * 70)
    print("Memory Server (stdio) - Auto-starts via npx")
    print("=" * 70)
    
    print("\n# No manual server startup needed!")
    print("# Just use in Python:")
    print("-" * 70)
    print("""
from gem.tools.mcp_server.memory import create_memory_tool

# Create Memory tool (auto-starts server)
memory_tool = create_memory_tool(
    memory_file_path="./memory.json",
    validate_on_init=False  # Fast startup
)

# Get available tools
tools = memory_tool.get_available_tools()
print(f"Found {len(tools)} Memory tools")

# Execute action
action = '''
<tool_call>
<tool_name>create_entities</tool_name>
<arguments>
{
  "entities": [{
    "name": "Python",
    "entityType": "language",
    "observations": ["Python is great"]
  }]
}
</arguments>
</tool_call>
'''

is_valid, has_error, obs, parsed = memory_tool.execute_action(action)
print(obs)
""")


def show_common_interface():
    """Show the common interface"""
    print("\n" + "=" * 70)
    print("Common Interface - Both servers use the same methods!")
    print("=" * 70)
    print("""
# After creation, both tools have the SAME interface:

# 1. Get tools
tools = tool.get_available_tools()

# 2. Execute actions (same format)
is_valid, has_error, obs, parsed = tool.execute_action(action)

# 3. Get instruction string
instruction = tool.instruction_string()

# 4. Use with GEM environments
from gem.tools.tool_env_wrapper import ToolEnvWrapper
wrapped_env = ToolEnvWrapper(base_env, tools=[tool])

# 5. Close when done
tool.close()
""")


def show_side_by_side():
    """Show side-by-side comparison"""
    print("\n" + "=" * 70)
    print("Side-by-Side Comparison")
    print("=" * 70)
    
    print("\n{:<35} {:<35}".format("Canvas (HTTP)", "Memory (stdio)"))
    print("-" * 70)
    
    lines = [
        ("from gem.tools.mcp_tool import MCPTool", 
         "from gem.tools.mcp_server.memory import create_memory_tool"),
        ("", ""),
        ("tool = MCPTool.from_url(", 
         "tool = create_memory_tool("),
        ('    "http://127.0.0.1:8082/canvas-mcp",',
         '    memory_file_path="./memory.json",'),
        ("    validate_on_init=False",
         "    validate_on_init=False"),
        (")", ")"),
        ("", ""),
        ("# Same interface from here!", 
         "# Same interface from here!"),
        ("tools = tool.get_available_tools()",
         "tools = tool.get_available_tools()"),
        ("tool.execute_action(action)",
         "tool.execute_action(action)"),
    ]
    
    for left, right in lines:
        print("{:<35} {:<35}".format(left, right))


def main():
    """Main demonstration"""
    print("=" * 70)
    print("MCP Servers - Consistent Usage Patterns")
    print("=" * 70)
    print("\nBoth Canvas and Memory servers now use similar, clean syntax!")
    
    show_side_by_side()
    show_canvas_usage()
    show_memory_usage()
    show_common_interface()
    
    print("\n" + "=" * 70)
    print("Key Takeaway")
    print("=" * 70)
    print("""
✓ Canvas and Memory use similar creation patterns
✓ Both accept validate_on_init=False for fast startup
✓ After creation, they share the SAME interface
✓ Both work with GEM environments in the same way

The only difference is HOW you create them:
  - Canvas (HTTP):  MCPTool.from_url(url, validate_on_init=False)
  - Memory (stdio): create_memory_tool(validate_on_init=False)

After that, everything else is identical!
""")
    
    print("=" * 70)
    print("Try it out!")
    print("=" * 70)
    print("\n# Test Canvas (requires server running):")
    print("python gem/tools/mcp_server/canvas/test_canvas_server.py")
    print("\n# Test Memory (auto-starts):")
    print("python gem/tools/mcp_server/memory/test_memory_tool.py")
    print("\n# Test both together:")
    print("python gem/tools/mcp_server/test_all_servers.py")
    print()


if __name__ == "__main__":
    main()
