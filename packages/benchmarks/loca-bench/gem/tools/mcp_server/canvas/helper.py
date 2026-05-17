"""Helper functions for creating Canvas MCP Tool instances.

DEPRECATED: This helper module is deprecated and will be removed in version 2.0.
Please migrate to the YAML-based configuration system using config_loader.

See: gem/tools/mcp_server/YAML_MIGRATION_GUIDE.md

This module provides helpers for both HTTP and stdio modes:
- HTTP mode: For the FastMCP Canvas server (manual start required)
- stdio mode: For the original Canvas server (auto-starts via command)
"""

from __future__ import annotations

import os
import warnings
from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_canvas_stdio_config(
    data_dir: Optional[str] = None,
    login_id: Optional[str] = None,
    password: Optional[str] = None,
    server_script: Optional[str] = None,
    server_name: str = "canvas"
) -> dict:
    """Get Canvas stdio server configuration (without creating MCPTool).

    DEPRECATED: This function is deprecated and will be removed in version 2.0.
    Use config_loader.build_server_config('canvas', params) instead.

    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.

    Args:
        data_dir: Path to Canvas data directory (default: ./canvas_data)
        login_id: Auto-login user ID (optional)
        password: Auto-login password (optional)
        server_script: Path to Canvas server.py (default: auto-detect from mcp_convert)
        server_name: Name for this server in the config (default: "canvas")
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Get individual configs
        canvas_config = get_canvas_stdio_config(data_dir="./canvas_data")
        claim_done_config = get_claim_done_stdio_config()
        
        # Merge configs
        merged_config = {
            "mcpServers": {
                **canvas_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    warnings.warn(
        "get_canvas_stdio_config() is deprecated and will be removed in v2.0. "
        "Use config_loader.build_server_config('canvas', params, server_name) instead. "
        "See gem/tools/mcp_server/YAML_MIGRATION_GUIDE.md for migration guide.",
        DeprecationWarning,
        stacklevel=2
    )

    # Default data directory
    if data_dir is None:
        data_dir = "./canvas_data"
    
    # Ensure data directory exists
    data_path = Path(data_dir)
    data_path.mkdir(parents=True, exist_ok=True)
    abs_data_dir = str(data_path.absolute())
    
    # Auto-detect server script if not provided
    if server_script is None:
        # Try to find the original Canvas server
        current_file = Path(__file__)
        
        # Option 1: gem/mcp_convert (local copy, preferred)
        mcp_convert_path = current_file.parent.parent.parent.parent.parent / "mcp_convert" / "mcps" / "canvas" / "server.py"
        if mcp_convert_path.exists():
            server_script = str(mcp_convert_path.absolute())
        else:
            # Option 2: mcpbench_dev/mcp_convert (development)
            mcp_convert_path = Path("mcp_convert/mcps/canvas/server.py")
            if mcp_convert_path.exists():
                server_script = str(mcp_convert_path.absolute())
            else:
                raise ValueError(
                    "Cannot find Canvas server script. Please provide server_script parameter. "
                    "Expected locations:\n"
                    f"  - gem/mcp_convert/mcps/canvas/server.py (preferred)\n"
                    f"  - mcpbench_dev/mcp_convert/mcps/canvas/server.py\n"
                )
    
    # Get gem project root or mcp_convert root (where pyproject.toml is)
    # Canvas server may be in mcp_convert subdirectory which has its own pyproject.toml
    server_path = Path(server_script)
    if "mcp_convert" in server_path.parts:
        # Use mcp_convert's pyproject.toml
        project_root = server_path.parent.parent.parent  # mcps/canvas/server.py -> mcp_convert/
    else:
        # Use gem's pyproject.toml
        project_root = Path(__file__).parent.parent.parent.parent
    
    # Build command arguments
    args = [server_script]
    
    # Add login credentials if provided
    if login_id:
        args.extend(["--login_id", login_id])
    if password:
        args.extend(["--password", password])
    
    # Return single server config (without mcpServers wrapper)
    # Include LOCA_QUIET to suppress verbose output (default to "1" for quiet mode)
    env = {
        "CANVAS_DATA_DIR": abs_data_dir,
        "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
    }
    return {
        server_name: {
            "command": "python",
            "args": args,
            "env": env
        }
    }


def create_canvas_tool_http(
    canvas_url: str = "http://127.0.0.1:8082/canvas-mcp",
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create Canvas tool using HTTP transport (FastMCP server).
    
    This connects to a running Canvas FastMCP server via HTTP.
    You must start the server manually first.
    
    Args:
        canvas_url: URL of the Canvas MCP server
        validate_on_init: Whether to validate on initialization
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance configured for HTTP Canvas server
    
    Examples:
        # Start server first:
        # cd canvas && python server.py --transport streamable-http --port 8082
        
        # Then create tool
        tool = create_canvas_tool_http(validate_on_init=False)
        
        # Use the tool
        tools = tool.get_available_tools()
        action = '<tool_call><tool_name>canvas_health_check</tool_name>...</tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    return MCPTool.from_url(canvas_url, validate_on_init=validate_on_init, **kwargs)


def create_canvas_tool_stdio(
    data_dir: Optional[str] = None,
    login_id: Optional[str] = None,
    password: Optional[str] = None,
    server_script: Optional[str] = None,
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create Canvas tool using stdio transport (auto-starts server).
    
    This uses the original Canvas server from mcp_convert, which runs
    via stdio and auto-starts. No manual server startup needed!
    
    Args:
        data_dir: Path to Canvas data directory (default: ./canvas_data)
        login_id: Auto-login user ID (optional)
        password: Auto-login password (optional)
        server_script: Path to Canvas server.py (default: auto-detect from mcp_convert)
        validate_on_init: Whether to validate on initialization
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance configured for stdio Canvas server
    
    Examples:
        # Auto-starts Canvas server via stdio
        tool = create_canvas_tool_stdio(
            data_dir="./canvas_data",
            login_id="student1",
            password="password123",
            validate_on_init=False
        )
        
        # Use the tool (no manual server startup needed!)
        tools = tool.get_available_tools()
        action = '<tool_call><tool_name>canvas_health_check</tool_name>...</tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    # Get server config
    server_config = get_canvas_stdio_config(
        data_dir=data_dir,
        login_id=login_id,
        password=password,
        server_script=server_script
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


# Alias for backwards compatibility and simplicity
create_canvas_tool = create_canvas_tool_http


__all__ = [
    "get_canvas_stdio_config",
    "create_canvas_tool",
    "create_canvas_tool_http", 
    "create_canvas_tool_stdio",
]
