"""Helper functions for creating Filesystem MCP Tool instances."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_filesystem_stdio_config(
    allowed_directory: Optional[str] = None,
    workspace_path: Optional[str] = None,
    server_name: str = "filesystem",
    use_local_server: bool = False,
) -> dict:
    """Get Filesystem stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    Args:
        allowed_directory: Directory path that the filesystem server can access.
            If not specified, uses workspace_path or current directory.
        workspace_path: Alias for allowed_directory (for consistency with other servers).
        server_name: Name for this server in the config (default: "filesystem")
        use_local_server: If True, use local TypeScript server (recommended).
                          If False, use npx to download server (may timeout).
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Get individual configs (using local server - recommended)
        filesystem_config = get_filesystem_stdio_config(allowed_directory="/path/to/workspace")
        claim_done_config = get_claim_done_stdio_config()
        
        # Merge configs
        merged_config = {
            "mcpServers": {
                **filesystem_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Support both allowed_directory and workspace_path
    directory = allowed_directory if allowed_directory is not None else workspace_path
    if directory is None:
        directory = "."
    
    # Convert to absolute path
    abs_directory = str(Path(directory).absolute())
    
    if use_local_server:
        # Use compiled JavaScript from local TypeScript server (avoids npx timeout)
        server_script = Path(__file__).parent.parent / "filesystem_ts" / "dist" / "index.js"
        
        if not server_script.exists():
            raise FileNotFoundError(
                f"Compiled filesystem server not found at: {server_script}\n"
                f"Please run: cd {Path(__file__).parent.parent / 'filesystem_ts'} && npm install"
            )
        
        # Use node to run compiled JavaScript directly (fastest, no compilation needed)
        # Filesystem server takes allowed directory as command line argument
        # Set cwd so that relative paths in tool calls are resolved correctly
        # Use bash wrapper to suppress stderr from noisy npm package
        # exec 2>/dev/null ensures all stderr including from child processes is suppressed
        return {
            server_name: {
                "command": "bash",
                "args": [
                    "-c",
                    f"exec 2>/dev/null; node '{str(server_script.absolute())}' '{abs_directory}'"
                ],
                "cwd": abs_directory
            }
        }
    else:
        # Fallback to npx download (may timeout in distributed environments)
        # Set cwd so that relative paths in tool calls are resolved correctly
        # Use bash wrapper to suppress stderr from noisy npm package
        # exec 2>/dev/null ensures all stderr including from child processes is suppressed
        return {
            server_name: {
                "command": "bash",
                "args": [
                    "-c",
                    f"exec 2>/dev/null; npx @modelcontextprotocol/server-filesystem '{abs_directory}'"
                ],
                "cwd": abs_directory
            }
        }


def create_filesystem_tool(
    allowed_directory: Optional[str] = None,
    workspace_path: Optional[str] = None,
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the Filesystem MCP server.
    
    The Filesystem server provides file reading and writing capabilities
    within a specified directory.
    
    Available tools typically include:
    - read_file: Read contents of a file
    - read_multiple_files: Read multiple files at once
    - write_file: Write content to a file
    - create_directory: Create a new directory
    - list_directory: List contents of a directory
    - move_file: Move or rename a file
    - search_files: Search for files by name or pattern
    - get_file_info: Get metadata about a file
    
    Args:
        allowed_directory: Directory path that the filesystem server can access.
            If not specified, uses workspace_path or current directory.
        workspace_path: Alias for allowed_directory (for consistency).
        validate_on_init: Whether to validate connection on initialization.
            Defaults to False for faster startup.
        **kwargs: Additional arguments passed to MCPTool constructor
            (e.g., max_retries, execution_timeout)
    
    Returns:
        MCPTool instance configured for the Filesystem server
    
    Examples:
        # Basic usage with current directory
        tool = create_filesystem_tool()
        
        # Specify allowed directory
        tool = create_filesystem_tool(
            allowed_directory="/path/to/workspace"
        )
        
        # Using workspace_path alias
        tool = create_filesystem_tool(
            workspace_path="./agent_workspace"
        )
        
        # With custom timeout and retries
        tool = create_filesystem_tool(
            allowed_directory="./workspace",
            max_retries=5,
            execution_timeout=60.0
        )
        
        # Get available tools
        tools = tool.get_available_tools()
        for t in tools:
            print(f"{t['function']['name']}: {t['function']['description']}")
    """
    # Get server config
    server_config = get_filesystem_stdio_config(
        allowed_directory=allowed_directory,
        workspace_path=workspace_path
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    # Create and return MCPTool instance
    return MCPTool(config=config, validate_on_init=validate_on_init, **kwargs)


__all__ = [
    "get_filesystem_stdio_config",
    "create_filesystem_tool",
]

