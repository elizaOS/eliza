"""Helper functions for creating Email MCP Tool instances.

This module provides helpers for both HTTP and stdio modes:
- HTTP mode: For the FastMCP Email server (manual start required)
- stdio mode: For the original Email server (auto-starts via command)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_email_stdio_config(
    data_dir: Optional[str] = None,
    email: Optional[str] = None,
    password: Optional[str] = None,
    server_script: Optional[str] = None,
    server_name: str = "email"
) -> dict:
    """Get Email stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    Args:
        data_dir: Path to Email data directory (default: ./email_data)
        email: Auto-login user email (optional)
        password: Auto-login password (optional)
        server_script: Path to Email server.py (default: auto-detect from mcp_convert)
        server_name: Name for this server in the config (default: "email")
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Get individual configs
        email_config = get_email_stdio_config(data_dir="./email_data")
        claim_done_config = get_claim_done_stdio_config()
        
        # Merge configs
        merged_config = {
            "mcpServers": {
                **email_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Default data directory
    if data_dir is None:
        data_dir = "./email_data"
    
    # Ensure data directory exists
    data_path = Path(data_dir)
    data_path.mkdir(parents=True, exist_ok=True)
    abs_data_dir = str(data_path.absolute())
    
    # Auto-detect server script if not provided
    if server_script is None:
        # Try to find the Email server
        current_file = Path(__file__)
        
        # Option 1: gem/mcp_convert (local copy, preferred)
        mcp_convert_path = current_file.parent.parent.parent.parent.parent / "mcp_convert" / "mcps" / "email" / "server.py"
        if mcp_convert_path.exists():
            server_script = str(mcp_convert_path.absolute())
        else:
            # Option 2: mcpbench_dev/mcp_convert (development)
            mcp_convert_path = Path("/mcp_convert/mcps/email/helper.py")
            if mcp_convert_path.exists():
                server_script = str(mcp_convert_path.absolute())
            else:
                # Option 3: mcp_convert in parallel to gem directory
                mcp_convert_path = current_file.parent.parent.parent.parent.parent / "mcp_convert" / "mcps" / "email" / "server.py"
                if mcp_convert_path.exists():
                    server_script = str(mcp_convert_path.absolute())
                else:
                    raise ValueError(
                        "Cannot find Email server script. Please provide server_script parameter. "
                        "Expected locations:\n"
                        f"  - gem/mcp_convert/mcps/email/server.py (preferred)\n"
                        f"  - mcpbench_dev/mcp_convert/mcps/email/server.py\n"
                        f"  - ../mcp_convert/mcps/email/server.py\n"
                    )
    
    # Get gem project root or mcp_convert root (where pyproject.toml is)
    # Email server may be in mcp_convert subdirectory which has its own pyproject.toml
    server_path = Path(server_script)
    if "mcp_convert" in server_path.parts:
        # Use mcp_convert's pyproject.toml
        project_root = server_path.parent.parent.parent  # mcps/email/server.py -> mcp_convert/
    else:
        # Use gem's pyproject.toml
        project_root = Path(__file__).parent.parent.parent.parent
    
    # Build command arguments
    args = [server_script]
    
    # Add login credentials if provided
    if email:
        args.extend(["--email", email])
    if password:
        args.extend(["--password", password])
    
    # Return single server config (without mcpServers wrapper)
    env = {
        "EMAIL_DATA_DIR": abs_data_dir,
        "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
    }
    return {
        server_name: {
            "command": "python",
            "args": args,
            "env": env
        }
    }


def create_email_tool_http(
    email_url: str = "http://127.0.0.1:8083/email-mcp",
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create Email tool using HTTP transport (FastMCP server).
    
    This connects to a running Email FastMCP server via HTTP.
    You must start the server manually first.
    
    Args:
        email_url: URL of the Email MCP server
        validate_on_init: Whether to validate on initialization
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance configured for HTTP Email server
    
    Examples:
        # Start server first:
        # cd email && python server.py --transport streamable-http --port 8083
        
        # Then create tool
        tool = create_email_tool_http(validate_on_init=False)
        
        # Use the tool
        tools = tool.get_available_tools()
        action = '<tool_call><tool_name>get_current_user</tool_name>...</tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    return MCPTool.from_url(email_url, validate_on_init=validate_on_init, **kwargs)


def create_email_tool_stdio(
    data_dir: Optional[str] = None,
    email: Optional[str] = None,
    password: Optional[str] = None,
    server_script: Optional[str] = None,
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create Email tool using stdio transport (auto-starts server).
    
    This uses the Email server from mcp_convert, which runs
    via stdio and auto-starts. No manual server startup needed!
    
    Args:
        data_dir: Path to Email data directory (default: ./email_data)
        email: Auto-login user email (optional)
        password: Auto-login password (optional)
        server_script: Path to Email server.py (default: auto-detect from mcp_convert)
        validate_on_init: Whether to validate on initialization
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance configured for stdio Email server
    
    Examples:
        # Auto-starts Email server via stdio
        tool = create_email_tool_stdio(
            data_dir="./email_data",
            email="user1@example.com",
            password="password123",
            validate_on_init=False
        )
        
        # Use the tool (no manual server startup needed!)
        tools = tool.get_available_tools()
        action = '<tool_call><tool_name>get_current_user</tool_name>...</tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    # Get server config
    server_config = get_email_stdio_config(
        data_dir=data_dir,
        email=email,
        password=password,
        server_script=server_script
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


# Alias for backwards compatibility and simplicity
create_email_tool = create_email_tool_http


__all__ = [
    "get_email_stdio_config",
    "create_email_tool",
    "create_email_tool_http",
    "create_email_tool_stdio",
]

