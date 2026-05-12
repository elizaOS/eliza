"""MCP Server utilities and configurations.

This module provides helper functions for creating MCP tools with various server configurations.

Supported modes:
- Canvas: HTTP (FastMCP) or stdio (original server)
- Memory: stdio (npx-based)
- ClaimDone: HTTP or stdio
- PythonExecute: HTTP or stdio
"""

from typing import Dict, Any, Optional


def create_canvas_memory_config(
    canvas_url: str = "http://127.0.0.1:8082/canvas-mcp",
    memory_file_path: str = "./memory.json"
) -> Dict[str, Any]:
    """Create a multi-server configuration for Canvas and Memory.
    
    This creates a unified configuration that connects to both Canvas (HTTP)
    and Memory (stdio) servers in a single MCPTool instance.
    
    Args:
        canvas_url: URL of the Canvas MCP server
        memory_file_path: Path to the memory JSON file
    
    Returns:
        Configuration dictionary for MCPTool
    
    Examples:
        >>> from gem.tools.mcp_tool import MCPTool
        >>> from gem.tools.mcp_server import create_canvas_memory_config
        >>> 
        >>> config = create_canvas_memory_config()
        >>> tool = MCPTool(config, validate_on_init=False)
        >>> 
        >>> # Tools are prefixed by server name:
        >>> # canvas_health_check, canvas_list_courses, etc.
        >>> # memory_create_entities, memory_search_nodes, etc.
        >>> tools = tool.get_available_tools()
    """
    return {
        "mcpServers": {
            "canvas": {
                "transport": "http",
                "url": canvas_url
            },
            "memory": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"],
                "env": {
                    "MEMORY_FILE_PATH": memory_file_path
                }
            }
        }
    }


def create_multi_server_tool(
    canvas_url: str = "http://127.0.0.1:8082/canvas-mcp",
    memory_file_path: str = "./memory.json",
    validate_on_init: bool = False,
    **kwargs
):
    """Create a single MCPTool with both Canvas and Memory servers.
    
    This is a convenience function that creates a multi-server configuration
    and returns an MCPTool instance ready to use.
    
    Args:
        canvas_url: URL of the Canvas MCP server
        memory_file_path: Path to the memory JSON file
        validate_on_init: Whether to validate on initialization (default: False)
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance configured with both servers
    
    Examples:
        >>> from gem.tools.mcp_server import create_multi_server_tool
        >>> 
        >>> # Create tool with both servers
        >>> tool = create_multi_server_tool()
        >>> 
        >>> # Get all tools from both servers
        >>> tools = tool.get_available_tools()
        >>> 
        >>> # Execute actions (tools are prefixed)
        >>> action = '<tool_call><tool_name>canvas_health_check</tool_name>...'
        >>> is_valid, has_error, obs, parsed = tool.execute_action(action)
        >>> 
        >>> action = '<tool_call><tool_name>memory_create_entities</tool_name>...'
        >>> is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    from gem.tools.mcp_tool import MCPTool
    
    config = create_canvas_memory_config(canvas_url, memory_file_path)
    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


def create_canvas_memory_config_stdio(
    canvas_data_dir: str = "./canvas_data",
    canvas_login_id: Optional[str] = None,
    canvas_password: Optional[str] = None,
    memory_file_path: str = "./memory.json",
    canvas_server_script: Optional[str] = None
) -> Dict[str, Any]:
    """Create multi-server config with Canvas stdio mode (auto-starts both servers).
    
    This creates a configuration where BOTH Canvas and Memory auto-start via stdio.
    No manual server startup needed!
    
    Args:
        canvas_data_dir: Path to Canvas data directory
        canvas_login_id: Optional auto-login user ID for Canvas
        canvas_password: Optional auto-login password for Canvas
        memory_file_path: Path to Memory JSON file
        canvas_server_script: Path to Canvas server.py (auto-detected if None)
    
    Returns:
        Configuration dictionary for MCPTool
    
    Examples:
        >>> from gem.tools.mcp_tool import MCPTool
        >>> from gem.tools.mcp_server import create_canvas_memory_config_stdio
        >>> 
        >>> # Both servers auto-start!
        >>> config = create_canvas_memory_config_stdio()
        >>> tool = MCPTool(config, validate_on_init=False)
        >>> 
        >>> # Tools are prefixed by server name:
        >>> # canvas_health_check, canvas_list_courses, etc.
        >>> # memory_create_entities, memory_search_nodes, etc.
    """
    from pathlib import Path
    
    # Setup Canvas data directory
    data_path = Path(canvas_data_dir)
    data_path.mkdir(parents=True, exist_ok=True)
    abs_canvas_dir = str(data_path.absolute())
    
    # Setup Memory file path
    memory_path = Path(memory_file_path)
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    abs_memory_path = str(memory_path.absolute())
    
    # Auto-detect Canvas server script if not provided
    if canvas_server_script is None:
        current_file = Path(__file__)
        
        # Try gem/mcp_convert (local copy, preferred)
        mcp_convert_path = current_file.parent.parent.parent.parent / "mcp_convert" / "mcps" / "canvas" / "server.py"
        if mcp_convert_path.exists():
            canvas_server_script = str(mcp_convert_path.absolute())
        else:
            # Try mcpbench_dev/mcp_convert
            mcp_convert_path = current_file.parent.parent.parent.parent / "mcpbench_dev" / "mcp_convert" / "mcps" / "canvas" / "server.py"
            if mcp_convert_path.exists():
                canvas_server_script = str(mcp_convert_path.absolute())
            else:
                raise ValueError(
                    "Cannot find Canvas server script. Expected at:\n"
                    "  - gem/mcp_convert/mcps/canvas/server.py (preferred)\n"
                    "  - mcpbench_dev/mcp_convert/mcps/canvas/server.py\n"
                )
    
    # Build Canvas command arguments
    canvas_args = [canvas_server_script]
    if canvas_login_id:
        canvas_args.extend(["--login_id", canvas_login_id])
    if canvas_password:
        canvas_args.extend(["--password", canvas_password])
    
    return {
        "mcpServers": {
            "canvas": {
                "command": "python",
                "args": canvas_args,
                "env": {
                    "CANVAS_DATA_DIR": abs_canvas_dir
                }
            },
            "memory": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"],
                "env": {
                    "MEMORY_FILE_PATH": abs_memory_path
                }
            }
        }
    }


def create_multi_server_tool_stdio(
    canvas_data_dir: str = "./canvas_data",
    canvas_login_id: Optional[str] = None,
    canvas_password: Optional[str] = None,
    memory_file_path: str = "./memory.json",
    validate_on_init: bool = False,
    **kwargs
):
    """Create MCPTool with both Canvas and Memory in stdio mode (auto-starts).
    
    Both servers auto-start - no manual setup required!
    
    Args:
        canvas_data_dir: Path to Canvas data directory
        canvas_login_id: Optional auto-login user ID for Canvas
        canvas_password: Optional auto-login password for Canvas
        memory_file_path: Path to Memory JSON file
        validate_on_init: Whether to validate on initialization
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance with both servers configured
    
    Examples:
        >>> from gem.tools.mcp_server import create_multi_server_tool_stdio
        >>> 
        >>> # Both servers auto-start - no manual setup!
        >>> tool = create_multi_server_tool_stdio(
        ...     canvas_login_id="student1",
        ...     canvas_password="password123",
        ...     validate_on_init=False
        ... )
        >>> 
        >>> # Get all tools from both servers
        >>> tools = tool.get_available_tools()
    """
    from gem.tools.mcp_tool import MCPTool
    
    config = create_canvas_memory_config_stdio(
        canvas_data_dir=canvas_data_dir,
        canvas_login_id=canvas_login_id,
        canvas_password=canvas_password,
        memory_file_path=memory_file_path
    )
    
    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


__all__ = [
    "create_canvas_memory_config",
    "create_canvas_memory_config_stdio",
    "create_multi_server_tool",
    "create_multi_server_tool_stdio",
]
