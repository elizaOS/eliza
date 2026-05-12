"""Helper functions for creating Excel MCP Tool instances."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_excel_stdio_config(
    server_name: str = "excel",
    excel_files_path: Optional[str] = None,
    env_vars: Optional[dict] = None,
) -> dict:
    """Get Excel stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    The Excel server uses the excel-mcp-server package which provides
    comprehensive Excel file manipulation capabilities.
    
    Args:
        server_name: Name for this server in the config (default: "excel")
        excel_files_path: Optional path to Excel files directory. Sets EXCEL_FILES_PATH env var.
            Note: For stdio transport, this is optional as paths can be provided per tool call.
            For SSE/HTTP transports, this is required (defaults to ./excel_files if not set).
        env_vars: Optional dictionary of additional environment variables to set
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Basic usage (stdio without default path)
        excel_config = get_excel_stdio_config()
        
        # With default Excel files path
        excel_config = get_excel_stdio_config(
            excel_files_path="/path/to/excel_files"
        )
        
        # With additional environment variables
        excel_config = get_excel_stdio_config(
            excel_files_path="/path/to/excel_files",
            env_vars={"FASTMCP_PORT": "8007"}
        )
        
        # Merge with other configs
        claim_done_config = get_claim_done_stdio_config()
        merged_config = {
            "mcpServers": {
                **excel_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Use excel-mcp-server directly (installed via uv pip install)
    # Reference: https://github.com/haris-musa/excel-mcp-server
    # Set cwd so that relative paths in Excel operations are resolved correctly
    config = {
        server_name: {
            "command": "excel-mcp-server",
            "args": ["stdio"]
        }
    }

    # Set cwd if excel_files_path is provided
    if excel_files_path is not None:
        abs_excel_path = str(Path(excel_files_path).absolute())
        config[server_name]["cwd"] = abs_excel_path

    # Add environment variables if specified
    env = {}
    if excel_files_path is not None:
        env["EXCEL_FILES_PATH"] = str(Path(excel_files_path).absolute())
    
    if env_vars:
        env.update(env_vars)
    
    if env:
        config[server_name]["env"] = env
    
    return config


def create_excel_tool(
    validate_on_init: bool = False,
    excel_files_path: Optional[str] = None,
    env_vars: Optional[dict] = None,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the Excel MCP server.
    
    The Excel server provides comprehensive Excel file manipulation capabilities
    including reading, writing, formatting, and data analysis operations.
    
    Available tools typically include:
    - read_excel: Read data from Excel files
    - write_excel: Write data to Excel files
    - format_cells: Apply formatting to cells
    - create_chart: Create charts in Excel
    - manage_sheets: Add, remove, or modify sheets
    - calculate_formulas: Evaluate Excel formulas
    - And more...
    
    Note: Requires excel-mcp-server to be installed via: uv pip install excel-mcp-server
    
    Args:
        validate_on_init: Whether to validate connection on initialization.
            Defaults to False for faster startup (like Canvas server usage).
        excel_files_path: Optional path to Excel files directory. Sets EXCEL_FILES_PATH env var.
            For stdio transport, this is optional as paths can be provided per tool call.
            For SSE/HTTP transports, this is required (defaults to ./excel_files if not set).
        env_vars: Optional dictionary of additional environment variables to set
        **kwargs: Additional arguments passed to MCPTool constructor
            (e.g., max_retries, execution_timeout, client_session_timeout_seconds)
    
    Returns:
        MCPTool instance configured for the Excel server
    
    Examples:
        # Basic usage
        tool = create_excel_tool()
        
        # With default Excel files path
        tool = create_excel_tool(excel_files_path="/path/to/excel_files")
        
        # With custom timeout settings and path
        tool = create_excel_tool(
            excel_files_path="/path/to/excel_files",
            validate_on_init=False,
            client_session_timeout_seconds=100,
            execution_timeout=60.0
        )
        
        # With additional environment variables
        tool = create_excel_tool(
            excel_files_path="/path/to/excel_files",
            env_vars={"FASTMCP_PORT": "8007"}
        )
        
        # Get available tools
        tools = tool.get_available_tools()
        for t in tools:
            print(f"{t['name']}: {t['description']}")
        
        # Execute an Excel operation
        action = '''<tool_call>
            <tool_name>read_excel</tool_name>
            <parameters>
                <file_path>/path/to/file.xlsx</file_path>
            </parameters>
        </tool_call>'''
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    # Get server config
    server_config = get_excel_stdio_config(
        excel_files_path=excel_files_path,
        env_vars=env_vars
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    # Create and return MCPTool instance
    return MCPTool(config=config, validate_on_init=validate_on_init, **kwargs)


def create_excel_tool_from_config(
    config_path: Optional[str] = None,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the Excel server from a config file.
    
    Args:
        config_path: Path to the configuration JSON file. If not specified,
            uses the default config.json in this directory.
        **kwargs: Additional arguments passed to MCPTool constructor
    
    Returns:
        MCPTool instance configured for the Excel server
    
    Examples:
        # Use default config
        tool = create_excel_tool_from_config()
        
        # Use custom config
        tool = create_excel_tool_from_config(
            config_path="/path/to/custom_config.json"
        )
    """
    if config_path is None:
        # Use default config.json in this directory
        current_dir = Path(__file__).parent
        config_path = current_dir / "config.json"
    
    return MCPTool.from_config_file(str(config_path), **kwargs)

