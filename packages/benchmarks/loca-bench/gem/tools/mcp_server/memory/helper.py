"""Helper functions for creating Memory MCP Tool instances."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_memory_stdio_config(
    memory_file_path: Optional[str] = None,
    server_name: str = "memory",
    use_local_server: bool = False,
) -> dict:
    """Get Memory stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    Args:
        memory_file_path: Path to the memory JSON file. If not specified,
            defaults to "./memory_data/memory.json" relative to current directory.
        server_name: Name for this server in the config (default: "memory")
        use_local_server: If True, use local TypeScript server (recommended).
                          If False, use npx to download server (may timeout).
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Get individual configs (using local server - recommended)
        memory_config = get_memory_stdio_config(memory_file_path="./memory.json")
        claim_done_config = get_claim_done_stdio_config()
        
        # Merge configs
        merged_config = {
            "mcpServers": {
                **memory_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Determine memory file path
    if memory_file_path is None:
        memory_file_path = "./memory_data/memory.json"
    
    # Ensure the parent directory exists
    memory_path = Path(memory_file_path)
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Convert to absolute path
    abs_memory_path = str(memory_path.absolute())
    
    if use_local_server:
        # Use compiled JavaScript from local TypeScript server (avoids npx timeout)
        server_script = Path(__file__).parent.parent / "memory_ts" / "dist" / "index.js"
        
        if not server_script.exists():
            raise FileNotFoundError(
                f"Compiled memory server not found at: {server_script}\n"
                f"Please run: cd {Path(__file__).parent.parent / 'memory_ts'} && npm install"
            )
        
        # Use node to run compiled JavaScript directly (fastest, no compilation needed)
        # Use bash wrapper to suppress stderr from noisy npm package
        # exec 2>/dev/null ensures all stderr including from child processes is suppressed
        return {
            server_name: {
                "command": "bash",
                "args": [
                    "-c",
                    f"exec 2>/dev/null; MEMORY_FILE_PATH='{abs_memory_path}' node '{str(server_script.absolute())}'"
                ],
                "env": {
                    "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
                }
            }
        }
    else:
        # Fallback to npx download (may timeout in distributed environments)
        # Use bash wrapper to suppress stderr from noisy npm package
        # exec 2>/dev/null ensures all stderr including from child processes is suppressed
        return {
            server_name: {
                "command": "bash",
                "args": [
                    "-c",
                    f"exec 2>/dev/null; MEMORY_FILE_PATH='{abs_memory_path}' npx @modelcontextprotocol/server-memory"
                ],
                "env": {
                    "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
                }
            }
        }


def create_memory_tool(
    memory_file_path: Optional[str] = None,
    validate_on_init: bool = False,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the Memory MCP server.
    
    The Memory server provides a knowledge graph-based memory system that allows
    storing and retrieving entities and their relationships across conversations.
    
    Available tools typically include:
    - create_entities: Store new information as entities with observations
    - create_relations: Define relationships between entities
    - read_graph: Query the knowledge graph
    - search_nodes: Search for specific entities
    - open_nodes: Retrieve detailed information about entities
    - delete_entities: Remove entities from the graph
    - delete_observations: Remove specific observations
    - delete_relations: Remove relationships
    
    Args:
        memory_file_path: Path to the memory JSON file. If not specified,
            defaults to "./memory_data/memory.json" relative to current directory.
        validate_on_init: Whether to validate connection on initialization.
            Defaults to False for faster startup (like Canvas server usage).
        **kwargs: Additional arguments passed to MCPTool constructor
            (e.g., max_retries, execution_timeout)
    
    Returns:
        MCPTool instance configured for the Memory server
    
    Examples:
        # Basic usage with default memory file
        tool = create_memory_tool()
        
        # Custom memory file location
        tool = create_memory_tool(
            memory_file_path="/path/to/my/memory.json"
        )
        
        # With custom timeout and retries
        tool = create_memory_tool(
            memory_file_path="./memory.json",
            max_retries=5,
            execution_timeout=60.0
        )
        
        # Get available tools
        tools = tool.get_available_tools()
        for t in tools:
            print(f"{t['name']}: {t['description']}")
    """
    # Get server config
    server_config = get_memory_stdio_config(memory_file_path=memory_file_path)
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    # Create and return MCPTool instance
    return MCPTool(config=config, validate_on_init=validate_on_init, **kwargs)


def create_memory_tool_from_config(
    config_path: Optional[str] = None,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the Memory server from a config file.
    
    Args:
        config_path: Path to the configuration JSON file. If not specified,
            uses the default config.json in this directory.
        **kwargs: Additional arguments passed to MCPTool constructor
    
    Returns:
        MCPTool instance configured for the Memory server
    
    Examples:
        # Use default config
        tool = create_memory_tool_from_config()
        
        # Use custom config
        tool = create_memory_tool_from_config(
            config_path="/path/to/custom_config.json"
        )
    """
    if config_path is None:
        # Use default config.json in this directory
        current_dir = Path(__file__).parent
        config_path = current_dir / "config.json"
    
    return MCPTool.from_config_file(str(config_path), **kwargs)
