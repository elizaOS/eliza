"""Helper functions to create Memory Tool MCP tool instances."""

from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_memory_tool_stdio_config(
    base_path: Optional[str] = None,
    server_name: str = "memory_tool"
) -> dict:
    """Get Memory Tool stdio server configuration (without creating MCPTool).

    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.

    Args:
        base_path: Path to the memory storage base directory (default: ./memory_storage)
        server_name: Name for this server in the config (default: "memory_tool")

    Returns:
        Dict with single server config: {server_name: {...}}

    Examples:
        # Get individual configs
        memory_config = get_memory_tool_stdio_config(base_path="/path/to/storage")
        python_config = get_python_execute_stdio_config()

        # Merge configs
        merged_config = {
            "mcpServers": {
                **memory_config,
                **python_config
            }
        }

        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Get path to memory_tool server script
    server_script = Path(__file__).parent / "server.py"

    if not server_script.exists():
        raise FileNotFoundError(
            f"Memory Tool server script not found at: {server_script}"
        )

    # Use default base path if not provided
    if base_path is None:
        base_path = "./memory_storage"

    # Convert base path to absolute path
    abs_base_path = str(Path(base_path).absolute())

    # Get parent directory for cwd - the base_path itself may not exist yet
    # (the server will create it when needed)
    parent_dir = str(Path(abs_base_path).parent)

    # Build command arguments
    args = [
        str(server_script),
        "--base-path", abs_base_path
    ]

    # Return single server config (without mcpServers wrapper)
    # Set cwd to parent directory since base_path may not exist yet
    return {
        server_name: {
            "command": "python",
            "args": args,
            "cwd": parent_dir,
            "env": {
                "MEMORY_TOOL_BASE_PATH": abs_base_path,
                "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
            }
        }
    }


def create_memory_tool_stdio(
    base_path: Optional[str] = None,
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create a Memory Tool MCP tool using stdio transport.

    Provides memory management tools (view, create, str_replace, insert, delete, rename)
    for file operations in a sandboxed /memories directory.

    Tool descriptions:
    - view: View directory contents or file contents in the /memories directory
    - create: Create or overwrite a file in the /memories directory
    - str_replace: Replace text in a file in the /memories directory
    - insert: Insert text at a specific line in a file in the /memories directory
    - delete: Delete a file or directory in the /memories directory
    - rename: Rename or move a file/directory in the /memories directory

    This starts the Memory Tool server as a subprocess and connects via stdio.

    Args:
        base_path: Path to the memory storage base directory (default: ./memory_storage)
        validate_on_init: Whether to validate the connection on initialization.
                         Set to False for faster startup.
        **kwargs: Additional arguments to pass to MCPTool constructor

    Returns:
        MCPTool configured for Memory Tool server via stdio

    Example:
        >>> from gem.tools.mcp_server.memory_tool import create_memory_tool_stdio
        >>> tool = create_memory_tool_stdio(base_path="/path/to/storage")
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[tool])
    """
    # Get server config
    server_config = get_memory_tool_stdio_config(base_path=base_path)

    # Wrap in mcpServers
    config = {"mcpServers": server_config}

    return MCPTool(config, validate_on_init=validate_on_init, **kwargs)


def create_memory_tool_http(
    host: str = "127.0.0.1",
    port: int = 8085,
    validate_on_init: bool = True,
    **kwargs
) -> MCPTool:
    """Create a Memory Tool MCP tool using HTTP transport.

    Note: You need to start the Memory Tool server separately:
        python -m gem.tools.mcp_server.memory_tool.server --transport streamable-http --port 8085 --base-path /path/to/storage

    Args:
        host: Server host (default: 127.0.0.1)
        port: Server port (default: 8085)
        validate_on_init: Whether to validate the connection on initialization
        **kwargs: Additional arguments to pass to MCPTool constructor

    Returns:
        MCPTool configured for Memory Tool server via HTTP

    Example:
        >>> from gem.tools.mcp_server.memory_tool import create_memory_tool_http
        >>> tool = create_memory_tool_http(port=8085)
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[tool])
    """
    url = f"http://{host}:{port}"
    return MCPTool.from_url(url, validate_on_init=validate_on_init, **kwargs)
