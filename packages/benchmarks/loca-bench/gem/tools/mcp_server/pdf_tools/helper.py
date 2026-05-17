"""Helper functions for creating PDF Tools MCP Tool instances.

This module provides helpers for the pdf-tools-mcp server which offers
comprehensive PDF file manipulation capabilities including reading,
extracting text, merging, splitting, and other PDF operations.

Package: https://github.com/lockon-n/pdf-tools-mcp
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_pdf_tools_stdio_config(
    workspace_path: Optional[str] = None,
    tempfile_dir: Optional[str] = None,
    server_name: str = "pdf_tools",
    env_vars: Optional[dict] = None,
) -> dict:
    """Get PDF Tools stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    The PDF Tools server uses the pdf-tools-mcp package which provides
    comprehensive PDF file manipulation capabilities.
    
    Args:
        workspace_path: Path to workspace where PDF operations are permitted.
            If not specified, defaults to current directory.
        tempfile_dir: Directory for temporary files created during PDF operations.
            If not specified, defaults to workspace_path/.pdf_tools_tempfiles
        server_name: Name for this server in the config (default: "pdf-tools")
        env_vars: Optional dictionary of additional environment variables to set
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Basic usage
        pdf_config = get_pdf_tools_stdio_config(workspace_path="/path/to/workspace")
        
        # With custom tempfile directory
        pdf_config = get_pdf_tools_stdio_config(
            workspace_path="/path/to/workspace",
            tempfile_dir="/path/to/temp"
        )
        
        # With additional environment variables
        pdf_config = get_pdf_tools_stdio_config(
            workspace_path="/path/to/workspace",
            env_vars={"CUSTOM_VAR": "value"}
        )
        
        # Merge with other configs
        excel_config = get_excel_stdio_config()
        merged_config = {
            "mcpServers": {
                **pdf_config,
                **excel_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Set default workspace path if not provided
    if workspace_path is None:
        workspace_path = "."

    # Convert to absolute path
    abs_workspace_path = str(Path(workspace_path).absolute())

    # Set default tempfile directory if not provided
    if tempfile_dir is None:
        tempfile_dir = f"{abs_workspace_path}/.pdf_tools_tempfiles"

    # Use uvx to run pdf-tools-mcp (as specified in pdf-tools.yaml)
    # Reference: https://github.com/lockon-n/pdf-tools-mcp
    # Set cwd so that relative paths in PDF operations are resolved correctly
    config = {
        server_name: {
            "command": "uvx",
            "args": [
                "pdf-tools-mcp",
                "--workspace_path",
                abs_workspace_path,
                "--tempfile_dir",
                tempfile_dir
            ],
            "cwd": abs_workspace_path
        }
    }
    
    # Add environment variables if specified
    if env_vars:
        config[server_name]["env"] = env_vars
    
    return config


def create_pdf_tools_tool(
    workspace_path: Optional[str] = None,
    tempfile_dir: Optional[str] = None,
    validate_on_init: bool = False,
    env_vars: Optional[dict] = None,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the PDF Tools MCP server.
    
    The PDF Tools server provides comprehensive PDF file manipulation capabilities
    including reading, extracting text, merging, splitting, and other operations.
    
    Available tools typically include:
    - extract_text: Extract text content from PDF files
    - get_pdf_info: Get metadata and information about PDF files
    - merge_pdfs: Combine multiple PDF files into one
    - split_pdf: Split a PDF file into multiple parts
    - convert_to_images: Convert PDF pages to images
    - And more...
    
    Note: Requires pdf-tools-mcp to be available via uvx
    Install with: uv tool install pdf-tools-mcp
    Or use: uvx pdf-tools-mcp (auto-installs)
    
    Args:
        workspace_path: Path to workspace where PDF operations are permitted.
            If not specified, defaults to current directory.
        tempfile_dir: Directory for temporary files created during PDF operations.
            If not specified, defaults to workspace_path/.pdf_tools_tempfiles
        validate_on_init: Whether to validate connection on initialization.
            Defaults to False for faster startup.
        env_vars: Optional dictionary of additional environment variables to set
        **kwargs: Additional arguments passed to MCPTool constructor
            (e.g., max_retries, execution_timeout, client_session_timeout_seconds)
    
    Returns:
        MCPTool instance configured for the PDF Tools server
    
    Examples:
        # Basic usage
        tool = create_pdf_tools_tool(workspace_path="/path/to/workspace")
        
        # With custom tempfile directory
        tool = create_pdf_tools_tool(
            workspace_path="/path/to/workspace",
            tempfile_dir="/path/to/temp"
        )
        
        # With custom timeout settings
        tool = create_pdf_tools_tool(
            workspace_path="/path/to/workspace",
            validate_on_init=False,
            client_session_timeout_seconds=120,
            execution_timeout=60.0
        )
        
        # With additional environment variables
        tool = create_pdf_tools_tool(
            workspace_path="/path/to/workspace",
            env_vars={"CUSTOM_VAR": "value"}
        )
        
        # Get available tools
        tools = tool.get_available_tools()
        for t in tools:
            print(f"{t['name']}: {t['description']}")
        
        # Execute a PDF operation
        action = '''<tool_call>
            <tool_name>extract_text</tool_name>
            <parameters>
                <file_path>/path/to/file.pdf</file_path>
            </parameters>
        </tool_call>'''
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    # Get server config
    server_config = get_pdf_tools_stdio_config(
        workspace_path=workspace_path,
        tempfile_dir=tempfile_dir,
        env_vars=env_vars,
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    # Create and return MCPTool instance
    return MCPTool(config=config, validate_on_init=validate_on_init, **kwargs)


def create_pdf_tools_tool_from_config(
    config_path: Optional[str] = None,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the PDF Tools server from a config file.
    
    Args:
        config_path: Path to the configuration JSON file. If not specified,
            uses the default config.json in this directory.
        **kwargs: Additional arguments passed to MCPTool constructor
    
    Returns:
        MCPTool instance configured for the PDF Tools server
    
    Examples:
        # Use default config
        tool = create_pdf_tools_tool_from_config()
        
        # Use custom config
        tool = create_pdf_tools_tool_from_config(
            config_path="/path/to/custom_config.json"
        )
    """
    if config_path is None:
        # Use default config.json in this directory
        current_dir = Path(__file__).parent
        config_path = current_dir / "config.json"
    
    return MCPTool.from_config_file(str(config_path), **kwargs)

