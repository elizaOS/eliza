"""Helper functions for creating Terminal MCP Tool instances.

This module provides helpers for the CLI MCP Server which offers terminal
command execution capabilities with safety controls and output management.

Package: https://github.com/MladenSU/cli-mcp-server
"""

from __future__ import annotations

import os
from typing import Optional

from gem.tools.mcp_tool import MCPTool


def get_terminal_stdio_config(
    agent_workspace: Optional[str] = None,
    allowed_dir: Optional[str] = None,
    allowed_commands: Optional[str] = None,
    allowed_flags: str = "all",
    max_command_length: int = 2048,
    command_timeout: int = 60,
    allow_shell_operators: bool = True,
    max_output_length: int = 10240,
    max_stdout_length: int = 8192,
    max_stderr_length: int = 2048,
    cli_proxy_enabled: bool = False,
    cli_proxy_url: str = "",
    server_name: str = "terminal",
    env_vars: Optional[dict] = None,
) -> dict:
    """Get Terminal stdio server configuration (without creating MCPTool).
    
    Returns a config dict that can be merged with other server configs
    before creating an MCPTool instance.
    
    The Terminal server uses the cli-mcp-server package which provides
    safe command execution with output management and access controls.
    
    Args:
        agent_workspace: Path to agent workspace (sets ALLOWED_DIR if allowed_dir not set)
        allowed_dir: Directory where file operations are permitted. If not set, uses agent_workspace.
        allowed_commands: Comma-separated list of allowed commands. 
            Default: Common shell commands (ls, cat, pwd, echo, cd, mkdir, touch, rm, cp, mv, 
            find, grep, head, tail, wc, sort, uniq, diff, tree, chmod, stat, file, which, 
            whoami, date, hostname, df, du, ps, env, history, clear, sed, awk, cut, tr, 
            basename, dirname, realpath, md5sum, sha256sum, tar, gzip, gunzip, zip, unzip, 
            less, more, python, wget, curl, ping, netstat, ifconfig, nslookup, traceroute, 
            helm, kubectl, git)
        allowed_flags: Which command flags are allowed ("all", "none", or comma-separated list)
        max_command_length: Maximum allowed command length in characters
        command_timeout: Command execution timeout in seconds
        allow_shell_operators: Whether to allow shell operators (pipes, redirects, etc.)
        max_output_length: Maximum total output length
        max_stdout_length: Maximum stdout length
        max_stderr_length: Maximum stderr length
        cli_proxy_enabled: Whether to enable proxy for CLI commands
        cli_proxy_url: Proxy URL if enabled
        server_name: Name for this server in the config (default: "terminal")
        env_vars: Optional dictionary of additional environment variables to set
    
    Returns:
        Dict with single server config: {server_name: {...}}
    
    Examples:
        # Basic usage
        terminal_config = get_terminal_stdio_config(agent_workspace="/path/to/workspace")
        
        # With custom allowed commands
        terminal_config = get_terminal_stdio_config(
            agent_workspace="/path/to/workspace",
            allowed_commands="ls,cat,pwd,echo,mkdir"
        )
        
        # With additional environment variables
        terminal_config = get_terminal_stdio_config(
            agent_workspace="/path/to/workspace",
            env_vars={"CUSTOM_VAR": "value"}
        )
        
        # Merge with other configs
        claim_done_config = get_claim_done_stdio_config()
        merged_config = {
            "mcpServers": {
                **terminal_config,
                **claim_done_config
            }
        }
        
        # Create combined tool
        tool = MCPTool(merged_config, validate_on_init=False)
    """
    # Default allowed commands (from terminal.yaml)
    default_commands = (
        "ls,cat,pwd,echo,cd,mkdir,touch,rm,cp,mv,find,grep,head,tail,wc,sort,uniq,"
        "diff,tree,chmod,stat,file,which,whoami,date,hostname,df,du,ps,env,history,"
        "clear,sed,awk,cut,tr,basename,dirname,realpath,md5sum,sha256sum,tar,gzip,"
        "gunzip,zip,unzip,less,more,python,wget,curl,ping,netstat,ifconfig,nslookup,"
        "traceroute,helm,kubectl,git"
    )
    
    # Determine allowed directory
    if allowed_dir is None:
        allowed_dir = agent_workspace if agent_workspace else "."

    # Convert to absolute path
    from pathlib import Path
    abs_allowed_dir = str(Path(allowed_dir).absolute())

    # Use uvx to run cli-mcp-server (as specified in terminal.yaml)
    # Reference: https://github.com/MladenSU/cli-mcp-server
    # Set cwd so that relative paths in commands are resolved correctly
    config = {
        server_name: {
            "command": "uvx",
            "args": ["cli-mcp-server"],
            "cwd": abs_allowed_dir,
            "env": {
                "ALLOWED_DIR": abs_allowed_dir,
                "ALLOWED_COMMANDS": allowed_commands if allowed_commands else default_commands,
                "ALLOWED_FLAGS": allowed_flags,
                "MAX_COMMAND_LENGTH": str(max_command_length),
                "COMMAND_TIMEOUT": str(command_timeout),
                "ALLOW_SHELL_OPERATORS": "true" if allow_shell_operators else "false",
                "MAX_OUTPUT_LENGTH": str(max_output_length),
                "MAX_STDOUT_LENGTH": str(max_stdout_length),
                "MAX_STDERR_LENGTH": str(max_stderr_length),
                "CLI_PROXY_ENABLED": "true" if cli_proxy_enabled else "false",
                "CLI_PROXY_URL": cli_proxy_url,
                "LOCA_QUIET": os.environ.get("LOCA_QUIET", "1"),
            }
        }
    }
    
    # Add additional environment variables if specified
    if env_vars:
        config[server_name]["env"].update(env_vars)
    
    return config


def create_terminal_tool(
    agent_workspace: Optional[str] = None,
    allowed_dir: Optional[str] = None,
    allowed_commands: Optional[str] = None,
    allowed_flags: str = "all",
    max_command_length: int = 2048,
    command_timeout: int = 60,
    allow_shell_operators: bool = True,
    max_output_length: int = 10240,
    max_stdout_length: int = 8192,
    max_stderr_length: int = 2048,
    cli_proxy_enabled: bool = False,
    cli_proxy_url: str = "",
    validate_on_init: bool = False,
    env_vars: Optional[dict] = None,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the Terminal MCP server.
    
    The Terminal server provides safe command execution capabilities with
    comprehensive access controls and output management.
    
    Available tools typically include:
    - execute_command: Execute shell commands with safety controls
    - list_allowed_commands: Get list of allowed commands
    - And more...
    
    Note: Requires cli-mcp-server to be available via uvx
    Install with: uv tool install cli-mcp-server
    Or use: uvx cli-mcp-server (auto-installs)
    
    Args:
        agent_workspace: Path to agent workspace (sets ALLOWED_DIR if allowed_dir not set)
        allowed_dir: Directory where file operations are permitted
        allowed_commands: Comma-separated list of allowed commands
        allowed_flags: Which command flags are allowed ("all", "none", or comma-separated list)
        max_command_length: Maximum allowed command length in characters
        command_timeout: Command execution timeout in seconds
        allow_shell_operators: Whether to allow shell operators (pipes, redirects, etc.)
        max_output_length: Maximum total output length
        max_stdout_length: Maximum stdout length
        max_stderr_length: Maximum stderr length
        cli_proxy_enabled: Whether to enable proxy for CLI commands
        cli_proxy_url: Proxy URL if enabled
        validate_on_init: Whether to validate connection on initialization.
            Defaults to False for faster startup.
        env_vars: Optional dictionary of additional environment variables to set
        **kwargs: Additional arguments passed to MCPTool constructor
            (e.g., max_retries, execution_timeout, client_session_timeout_seconds)
    
    Returns:
        MCPTool instance configured for the Terminal server
    
    Examples:
        # Basic usage
        tool = create_terminal_tool(agent_workspace="/path/to/workspace")
        
        # With limited commands
        tool = create_terminal_tool(
            agent_workspace="/path/to/workspace",
            allowed_commands="ls,cat,pwd,echo,mkdir",
            allowed_flags="none"
        )
        
        # With custom timeout and output limits
        tool = create_terminal_tool(
            agent_workspace="/path/to/workspace",
            command_timeout=120,
            max_output_length=20480,
            validate_on_init=False
        )
        
        # With proxy
        tool = create_terminal_tool(
            agent_workspace="/path/to/workspace",
            cli_proxy_enabled=True,
            cli_proxy_url="http://proxy.example.com:8080"
        )
        
        # Get available tools
        tools = tool.get_available_tools()
        for t in tools:
            print(f"{t['name']}: {t['description']}")
        
        # Execute a command
        action = '''<tool_call>
            <tool_name>execute_command</tool_name>
            <parameters>
                <command>ls -la</command>
            </parameters>
        </tool_call>'''
        is_valid, has_error, obs, parsed = tool.execute_action(action)
    """
    # Get server config
    server_config = get_terminal_stdio_config(
        agent_workspace=agent_workspace,
        allowed_dir=allowed_dir,
        allowed_commands=allowed_commands,
        allowed_flags=allowed_flags,
        max_command_length=max_command_length,
        command_timeout=command_timeout,
        allow_shell_operators=allow_shell_operators,
        max_output_length=max_output_length,
        max_stdout_length=max_stdout_length,
        max_stderr_length=max_stderr_length,
        cli_proxy_enabled=cli_proxy_enabled,
        cli_proxy_url=cli_proxy_url,
        env_vars=env_vars,
    )
    
    # Wrap in mcpServers
    config = {"mcpServers": server_config}
    
    # Create and return MCPTool instance
    return MCPTool(config=config, validate_on_init=validate_on_init, **kwargs)


def create_terminal_tool_from_config(
    config_path: str,
    **kwargs
) -> MCPTool:
    """Create an MCPTool instance for the Terminal server from a config file.
    
    Args:
        config_path: Path to the configuration JSON file
        **kwargs: Additional arguments passed to MCPTool constructor
    
    Returns:
        MCPTool instance configured for the Terminal server
    
    Examples:
        # Use custom config
        tool = create_terminal_tool_from_config(
            config_path="/path/to/terminal_config.json"
        )
    """
    return MCPTool.from_config_file(str(config_path), **kwargs)

