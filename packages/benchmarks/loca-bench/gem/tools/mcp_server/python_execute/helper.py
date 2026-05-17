"""Helper functions to create Python Execute MCP tool instances."""

from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_python_execute_stdio_config(
    workspace_path: Optional[str] = None,
    workspace_dir: Optional[str] = None,
    server_name: str = "python_execute"
) -> dict:
    """Get Python Execute stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    Args:
        workspace_path: Path to the agent workspace directory (default: current directory)
        workspace_dir: Alias for workspace_path (for backward compatibility)
        server_name: Name for this server in the config (default: "python_execute")
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Get individual configs
        python_config = get_python_execute_stdio_config(workspace_path="/path/to/workspace")
        claim_done_config = get_claim_done_stdio_config()
        
        # Merge configs
        merged_config = {
            "mcpServers": {
                **python_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Get path to python_execute server script
    server_script = Path(__file__).parent / "server.py"
    
    if not server_script.exists():
        raise FileNotFoundError(
            f"Python Execute server script not found at: {server_script}"
        )
    
    # Support both workspace_path and workspace_dir for backward compatibility
    workspace = workspace_dir if workspace_dir is not None else workspace_path
    if workspace is None:
        workspace = "."
    
    # Convert workspace path to absolute path
    abs_workspace = str(Path(workspace).absolute())
    
    # Get gem project root (where pyproject.toml is)
    gem_root = Path(__file__).parent.parent.parent.parent
    
    # Build command arguments - pass workspace via command line argument
    args = [
        str(server_script),
        "--workspace", abs_workspace
    ]
    
    # Return single server config (without mcpServers wrapper)
    # Set cwd so that relative paths in code execution are resolved correctly
    return {
        server_name: {
            "command": "python",
            "args": args,
            "cwd": abs_workspace,
            "env": {
                "PROGRAMMATIC_TOOL_CALLING_WORKSPACE": abs_workspace,
                "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
            }
        }
    }


def create_python_execute_tool_stdio(
    workspace_path: Optional[str] = None,
    workspace_dir: Optional[str] = None,
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create a Python Execute MCP tool using stdio transport.
    
    Provides a 'python_execute' tool that executes Python code in the agent workspace.
    Tool description: "Execute Python code directly under the agent workspace, and returns 
    stdout, stderr, return code, and execution time in a structured format."
    
    This starts the Python Execute server as a subprocess and connects via stdio.
    
    Args:
        workspace_path: Path to the agent workspace directory (default: current directory)
        workspace_dir: Alias for workspace_path (for backward compatibility)
        validate_on_init: Whether to validate the connection on initialization.
                         Set to False for faster startup.
        **kwargs: Additional arguments to pass to MCPTool constructor
    
    Returns:
        MCPTool configured for Python Execute server via stdio
        
    Example:
        >>> from gem.tools.mcp_server.python_execute import create_python_execute_tool_stdio
        >>> tool = create_python_execute_tool_stdio(workspace_path="/path/to/workspace")
        >>> # Or use workspace_dir
        >>> tool = create_python_execute_tool_stdio(workspace_dir="/path/to/workspace")
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[tool])
    """
    # Get server config
    server_config = get_python_execute_stdio_config(
        workspace_path=workspace_path,
        workspace_dir=workspace_dir
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


def create_python_execute_tool_http(
    host: str = "127.0.0.1",
    port: int = 8084,
    validate_on_init: bool = True,
    **kwargs
) -> MCPTool:
    """Create a Python Execute MCP tool using HTTP transport.
    
    Note: You need to start the Python Execute server separately:
        python -m gem.tools.mcp_server.python_execute.server --transport streamable-http --port 8084 --workspace /path/to/workspace
    
    Args:
        host: Server host (default: 127.0.0.1)
        port: Server port (default: 8084)
        validate_on_init: Whether to validate the connection on initialization
        **kwargs: Additional arguments to pass to MCPTool constructor
    
    Returns:
        MCPTool configured for Python Execute server via HTTP
        
    Example:
        >>> from gem.tools.mcp_server.python_execute import create_python_execute_tool_http
        >>> tool = create_python_execute_tool_http(port=8084)
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[tool])
    """
    url = f"http://{host}:{port}"
    return MCPTool.from_url(url, validate_on_init=validate_on_init, **kwargs)

