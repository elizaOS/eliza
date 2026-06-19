"""Helper functions for creating Calendar MCP Tool instances.

This module provides helpers for both HTTP and stdio modes:
- HTTP mode: For the FastMCP Calendar server (manual start required)
- stdio mode: For the original Calendar server (auto-starts via command)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_calendar_stdio_config(
    data_dir: Optional[str] = None,
    server_script: Optional[str] = None,
    server_name: str = "calendar"
) -> dict:
    """Get Calendar stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    Args:
        data_dir: Path to Calendar data directory (default: ./calendar_data)
        server_script: Path to Calendar server.py (default: auto-detect from mcp_convert)
        server_name: Name for this server in the config (default: "calendar")
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Get individual configs
        calendar_config = get_calendar_stdio_config(data_dir="./calendar_data")
        claim_done_config = get_claim_done_stdio_config()
        
        # Merge configs
        merged_config = {
            "mcpServers": {
                **calendar_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Default data directory
    if data_dir is None:
        data_dir = "./calendar_data"
    
    # Ensure data directory exists
    data_path = Path(data_dir)
    data_path.mkdir(parents=True, exist_ok=True)
    abs_data_dir = str(data_path.absolute())
    
    # Auto-detect server script if not provided
    if server_script is None:
        # Try to find the Calendar server
        current_file = Path(__file__)
        
        # Option 1: gem/mcp_convert (local copy, preferred)
        mcp_convert_path = current_file.parent.parent.parent.parent.parent / "mcp_convert" / "mcps" / "calendar" / "server.py"
        if mcp_convert_path.exists():
            server_script = str(mcp_convert_path.absolute())
        else:
            # Option 2: mcpbench_dev/mcp_convert (development)
            mcp_convert_path = Path("/mcp_convert/mcps/calendar/server.py")
            if mcp_convert_path.exists():
                server_script = str(mcp_convert_path.absolute())
            else:
                # Option 3: mcp_convert in parallel to gem directory
                mcp_convert_path = Path("/mcp_convert/mcps/calendar/server.py")
                if mcp_convert_path.exists():
                    server_script = str(mcp_convert_path.absolute())
                else:
                    raise ValueError(
                        "Cannot find Calendar server script. Please provide server_script parameter. "
                        "Expected locations:\n"
                        f"  - gem/mcp_convert/mcps/calendar/server.py (preferred)\n"
                        f"  - mcpbench_dev/mcp_convert/mcps/calendar/server.py\n"
                        f"  - mcp_convert/mcps/calendar/server.py\n"
                    )
    
    # Get gem project root or mcp_convert root (where pyproject.toml is)
    # Calendar server may be in mcp_convert subdirectory which has its own pyproject.toml
    server_path = Path(server_script)
    if "mcp_convert" in server_path.parts:
        # Use mcp_convert's pyproject.toml
        project_root = server_path.parent.parent.parent  # mcps/calendar/server.py -> mcp_convert/
    else:
        # Use gem's pyproject.toml
        project_root = Path(__file__).parent.parent.parent.parent
    
    # Build command arguments
    args = [
        "--directory",
        str(project_root),
        "run",
        "python",
        server_script
    ]
    
    # Return single server config (without mcpServers wrapper)
    # Based on calendar configuration
    return {
        server_name: {
            "command": "uv",
            "args": args,
            "env": {
                "CALENDAR_DATA_DIR": abs_data_dir,
                "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
            }
        }
    }


def create_calendar_tool_http(
    calendar_url: str = "http://127.0.0.1:8082/calendar-mcp",
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create Calendar tool using HTTP transport (FastMCP server).
    
    This connects to a running Calendar FastMCP server via HTTP.
    You must start the server manually first.
    
    Args:
        calendar_url: URL of the Calendar MCP server
        validate_on_init: Whether to validate on initialization
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance configured for HTTP Calendar server
    
    Examples:
        # Start server first:
        # cd calendar && python server.py --transport streamable-http --port 8082
        
        # Then create tool
        tool = create_calendar_tool_http(validate_on_init=False)
        
        # Use the tool
        tools = tool.get_available_tools()
        action = '<tool_call><tool_name>list_events</tool_name>...</tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    return MCPTool.from_url(calendar_url, validate_on_init=validate_on_init, **kwargs)


def create_calendar_tool_stdio(
    data_dir: Optional[str] = None,
    server_script: Optional[str] = None,
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create Calendar tool using stdio transport (auto-starts server).
    
    This uses the Calendar server from mcp_convert, which runs
    via stdio and auto-starts. No manual server startup needed!
    
    Args:
        data_dir: Path to Calendar data directory (default: ./calendar_data)
        server_script: Path to Calendar server.py (default: auto-detect from mcp_convert)
        validate_on_init: Whether to validate on initialization
        **kwargs: Additional arguments passed to MCPTool
    
    Returns:
        MCPTool instance configured for stdio Calendar server
    
    Examples:
        # Auto-starts Calendar server via stdio
        tool = create_calendar_tool_stdio(
            data_dir="./calendar_data",
            validate_on_init=False
        )
        
        # Use the tool (no manual server startup needed!)
        tools = tool.get_available_tools()
        action = '<tool_call><tool_name>list_events</tool_name><parameters><timeMin>2024-01-01T00:00:00Z</timeMin><timeMax>2024-12-31T23:59:59Z</timeMax></parameters></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
        
        # Create event
        action = '<tool_call><tool_name>create_event</tool_name><parameters><summary>Team Meeting</summary><start><dateTime>2024-01-15T10:00:00</dateTime><timeZone>America/New_York</timeZone></start><end><dateTime>2024-01-15T11:00:00</dateTime><timeZone>America/New_York</timeZone></end></parameters></tool_call>'
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    # Get server config
    server_config = get_calendar_stdio_config(
        data_dir=data_dir,
        server_script=server_script
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


# Alias for backwards compatibility and simplicity
create_calendar_tool = create_calendar_tool_http


__all__ = [
    "get_calendar_stdio_config",
    "create_calendar_tool",
    "create_calendar_tool_http",
    "create_calendar_tool_stdio",
]

