"""
Example: How to combine multiple MCP servers into a single MCPTool

This example demonstrates the new config-based approach for creating
multi-server MCPTool instances.
"""

from gem.tools.mcp_tool import MCPTool
from gem.tools.mcp_server.canvas.helper import get_canvas_stdio_config
from gem.tools.mcp_server.python_execute.helper import get_python_execute_stdio_config
from gem.tools.mcp_server.memory.helper import get_memory_stdio_config
from gem.tools.mcp_server.filesystem.helper import get_filesystem_stdio_config
from gem.tools.mcp_server.claim_done.helper import get_claim_done_stdio_config


def example_1_basic_multi_server():
    """Example 1: Combine Canvas, Python Execute, and ClaimDone servers"""
    
    # Get individual server configs
    canvas_config = get_canvas_stdio_config(
        data_dir="./canvas_data",
        login_id="student1",
        password="password123"
    )
    
    python_config = get_python_execute_stdio_config(
        workspace_path="./workspace"
    )
    
    claim_done_config = get_claim_done_stdio_config()
    
    # Merge configs
    merged_config = {
        "mcpServers": {
            **canvas_config,
            **python_config,
            **claim_done_config
        }
    }
    
    # Create combined tool
    tool = MCPTool(merged_config, validate_on_init=False)
    
    # Use the tool - it now has tools from all three servers!
    available_tools = tool.get_available_tools()
    print(f"Available tools: {[t['function']['name'] for t in available_tools]}")
    
    return tool


def example_2_with_filesystem():
    """Example 2: Add Filesystem server for file operations"""
    
    # Combine Python Execute, Filesystem, and ClaimDone
    python_config = get_python_execute_stdio_config(workspace_path="./workspace")
    filesystem_config = get_filesystem_stdio_config(allowed_directory="./workspace")
    claim_done_config = get_claim_done_stdio_config()
    
    merged_config = {
        "mcpServers": {
            **python_config,
            **filesystem_config,
            **claim_done_config
        }
    }
    
    tool = MCPTool(merged_config, validate_on_init=False)
    
    # Now you can use filesystem tools like:
    # - read_file: Read file contents
    # - write_file: Write to files
    # - list_directory: List directory contents
    # - create_directory: Create directories
    
    return tool


def example_3_with_memory_server():
    """Example 3: Add Memory server for knowledge graph-based memory"""
    
    # Combine Python Execute, Memory, and ClaimDone
    python_config = get_python_execute_stdio_config()
    memory_config = get_memory_stdio_config(memory_file_path="./memory.json")
    claim_done_config = get_claim_done_stdio_config()
    
    merged_config = {
        "mcpServers": {
            **python_config,
            **memory_config,
            **claim_done_config
        }
    }
    
    tool = MCPTool(merged_config, validate_on_init=False)
    
    # Now you can use memory tools like:
    # - create_entities: Store information
    # - read_graph: Query the knowledge graph
    # - search_nodes: Search for entities
    
    return tool


def example_4_all_servers():
    """Example 4: Combine ALL available servers!"""
    
    # Get all server configs
    canvas_config = get_canvas_stdio_config(data_dir="./canvas_data")
    python_config = get_python_execute_stdio_config(workspace_path="./workspace")
    filesystem_config = get_filesystem_stdio_config(allowed_directory="./workspace")
    memory_config = get_memory_stdio_config(memory_file_path="./memory.json")
    claim_done_config = get_claim_done_stdio_config()
    
    # Merge all configs
    merged_config = {
        "mcpServers": {
            **canvas_config,
            **python_config,
            **filesystem_config,
            **memory_config,
            **claim_done_config
        }
    }
    
    # Create super-powered tool with all capabilities!
    tool = MCPTool(merged_config, validate_on_init=False)
    
    return tool


def example_5_custom_server_names():
    """Example 5: Use custom server names to avoid conflicts"""
    
    # You can use custom server names if needed
    python_config_1 = get_python_execute_stdio_config(
        workspace_path="./workspace1",
        server_name="python_workspace1"
    )
    
    python_config_2 = get_python_execute_stdio_config(
        workspace_path="./workspace2",
        server_name="python_workspace2"
    )
    
    filesystem_config_1 = get_filesystem_stdio_config(
        allowed_directory="./workspace1",
        server_name="filesystem_workspace1"
    )
    
    filesystem_config_2 = get_filesystem_stdio_config(
        allowed_directory="./workspace2",
        server_name="filesystem_workspace2"
    )
    
    claim_done_config = get_claim_done_stdio_config()
    
    # Merge configs
    merged_config = {
        "mcpServers": {
            **python_config_1,
            **python_config_2,
            **filesystem_config_1,
            **filesystem_config_2,
            **claim_done_config
        }
    }
    
    # Create combined tool with multiple workspaces
    tool = MCPTool(merged_config, validate_on_init=False)
    
    return tool


def example_6_backward_compatible():
    """Example 6: The old way still works!"""
    
    # You can still use the old create_*_tool functions
    from gem.tools.mcp_server.claim_done.helper import create_claim_done_tool_stdio
    from gem.tools.mcp_server.filesystem.helper import create_filesystem_tool
    
    # Single server
    tool = create_filesystem_tool(allowed_directory="./workspace")
    
    return tool


if __name__ == "__main__":
    print("=" * 80)
    print("Example 1: Basic Multi-Server (Canvas + Python + ClaimDone)")
    print("=" * 80)
    # tool1 = example_1_basic_multi_server()
    
    print("\n" + "=" * 80)
    print("Example 2: With Filesystem (Python + Filesystem + ClaimDone)")
    print("=" * 80)
    # tool2 = example_2_with_filesystem()
    
    print("\n" + "=" * 80)
    print("Example 3: With Memory (Python + Memory + ClaimDone)")
    print("=" * 80)
    # tool3 = example_3_with_memory_server()
    
    print("\n" + "=" * 80)
    print("Example 4: ALL Servers (Canvas + Python + Filesystem + Memory + ClaimDone)")
    print("=" * 80)
    # tool4 = example_4_all_servers()
    
    print("\n" + "=" * 80)
    print("Example 5: Custom Server Names (Multiple Workspaces)")
    print("=" * 80)
    # tool5 = example_5_custom_server_names()
    
    print("\n" + "=" * 80)
    print("Example 6: Backward Compatible (Old Way)")
    print("=" * 80)
    # tool6 = example_6_backward_compatible()
    
    print("\n" + "=" * 80)
    print("✅ All examples defined successfully!")
    print("=" * 80)
    print("\nUncomment the lines above to actually run them.")
    print("\nAvailable get_*_config functions:")
    print("  - get_canvas_stdio_config(data_dir, login_id, password)")
    print("  - get_python_execute_stdio_config(workspace_path)")
    print("  - get_filesystem_stdio_config(allowed_directory)")
    print("  - get_memory_stdio_config(memory_file_path)")
    print("  - get_claim_done_stdio_config()")

