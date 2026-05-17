"""Helper functions to create ClaimDone MCP tool instances.

DEPRECATED: This helper module is deprecated and will be removed in version 2.0.
Please migrate to the YAML-based configuration system using config_loader.

See: gem/tools/mcp_server/YAML_MIGRATION_GUIDE.md
"""

import warnings
from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_claim_done_stdio_config(server_name: str = "claim_done") -> dict:
    """Get ClaimDone stdio server configuration (without creating MCPTool).

    DEPRECATED: This function is deprecated and will be removed in version 2.0.
    Use config_loader.build_server_config('claim_done', params) instead.

    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.

    Args:
        server_name: Name for this server in the config (default: "claim_done")

    Returns:
        Dict with single server config: {server_name: {...}}

    Examples:
        # Get individual configs
        claim_done_config = get_claim_done_stdio_config()
        python_config = get_python_execute_stdio_config()
        
        # Merge configs
        merged_config = {
            "mcpServers": {
                **claim_done_config,
                **python_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    warnings.warn(
        "get_claim_done_stdio_config() is deprecated and will be removed in v2.0. "
        "Use config_loader.build_server_config('claim_done', {}, server_name) instead. "
        "See gem/tools/mcp_server/YAML_MIGRATION_GUIDE.md for migration guide.",
        DeprecationWarning,
        stacklevel=2
    )

    # Get path to claim_done server script
    server_script = Path(__file__).parent / "server.py"
    
    if not server_script.exists():
        raise FileNotFoundError(
            f"ClaimDone server script not found at: {server_script}"
        )
    
    # Get gem project root (where pyproject.toml is)
    gem_root = Path(__file__).parent.parent.parent.parent
    
    # Build command arguments
    args = [str(server_script)]
    
    # Return single server config (without mcpServers wrapper)
    return {
        server_name: {
            "command": "python",
            "args": args
        }
    }


def create_claim_done_tool_stdio(
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create a ClaimDone MCP tool using stdio transport.
    
    Provides a 'claim_done' tool that agents can use to signal task completion.
    Tool description: "claim the task is done"
    
    This starts the ClaimDone server as a subprocess and connects via stdio.
    
    Args:
        validate_on_init: Whether to validate the connection on initialization.
                         Set to False for faster startup.
        **kwargs: Additional arguments to pass to MCPTool constructor
    
    Returns:
        MCPTool configured for ClaimDone server via stdio
        
    Example:
        >>> from gem.tools.mcp_server.claim_done import create_claim_done_tool_stdio
        >>> tool = create_claim_done_tool_stdio()
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[tool])
    """
    # Get server config
    server_config = get_claim_done_stdio_config()
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


def create_claim_done_tool_http(
    host: str = "127.0.0.1",
    port: int = 8083,
    validate_on_init: bool = True,
    **kwargs
) -> MCPTool:
    """Create a ClaimDone MCP tool using HTTP transport.
    
    Note: You need to start the ClaimDone server separately:
        python -m gem.tools.mcp_server.claim_done.server --transport streamable-http --port 8083
    
    Args:
        host: Server host (default: 127.0.0.1)
        port: Server port (default: 8083)
        validate_on_init: Whether to validate the connection on initialization
        **kwargs: Additional arguments to pass to MCPTool constructor
    
    Returns:
        MCPTool configured for ClaimDone server via HTTP
        
    Example:
        >>> from gem.tools.mcp_server.claim_done import create_claim_done_tool_http
        >>> tool = create_claim_done_tool_http(port=8083)
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[tool])
    """
    url = f"http://{host}:{port}"
    return MCPTool.from_url(url, validate_on_init=validate_on_init, **kwargs)

