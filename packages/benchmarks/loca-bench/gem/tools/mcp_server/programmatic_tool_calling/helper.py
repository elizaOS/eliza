"""Helper functions to create Programmatic Tool Calling MCP tool instances.

This module provides a specialized MCP tool that executes Python code with embedded
tool calling capabilities. Unlike regular python_execute, this allows code to invoke
tools as functions, with execution pausing while tools are executed via the tool executor.
"""

from pathlib import Path
from typing import Optional, Dict, Any, Tuple, List

from gem.tools.mcp_tool import MCPTool


class ProgrammaticToolCallingTool(MCPTool):
    """
    Extended MCPTool that wraps the programmatic_tool_calling server and
    provides tool execution capabilities to code running inside the server.

    This tool maintains a reference to other tools in the environment and
    executes them when Python code makes tool calls during execution.

    Important: Since MCP servers run in separate processes, this implementation
    uses a different approach - it intercepts tool calls in the code execution
    result and re-executes them in the parent process.
    """

    def __init__(
        self,
        config: dict,
        tools: Optional[List[Any]] = None,
        validate_on_init: bool = False,
        **kwargs
    ):
        """Initialize the Programmatic Tool Calling tool.

        Args:
            config: MCP server configuration
            tools: Optional list of other tools available for calling.
                   Can be set later using set_tools().
            validate_on_init: Whether to validate connection on initialization
            **kwargs: Additional arguments to pass to MCPTool constructor
        """
        super().__init__(config, validate_on_init=validate_on_init, **kwargs)
        self._other_tools = tools or []

    def set_tools(self, tools: List[Any]):
        """Set the list of other tools that can be called.

        This should be called after the tool is added to ToolEnvWrapper,
        so it can reference the other tools in self.tools.

        Args:
            tools: List of tool instances that this tool can call
        """
        self._other_tools = [t for t in tools if t is not self]

    def execute_tool(
        self,
        tool_name: str,
        parameters: Dict[str, Any],
        tool_call_id: str
    ) -> Tuple[bool, bool, str, str, str]:
        """Execute the programmatic_tool_calling tool.

        This method handles both:
        1. Executing the programmatic_tool_calling tool itself
        2. Executing nested tool calls that occur during code execution

        Works in two modes:
        - Multi-tool mode: Uses self._other_tools (set via set_tools())
        - Single-tool mode: Uses self (when part of single MCPTool with multiple servers)

        Args:
            tool_name: The name of the tool to execute
            parameters: The parameters of the tool to execute
            tool_call_id: Unique ID for this tool call

        Returns:
            Tuple of (tool_parsed, tool_execute_error, observation,
                     returned_tool_name, returned_tool_call_id)
        """
        # Check if this is calling programmatic_tool_calling itself
        # Only match tools from the programmatic_tool_calling server (named like "programmatic_tool_calling_code_execution")
        available_tools = self.get_available_tools()
        prog_tool_names = [
            t["name"] for t in available_tools
            if "programmatic_tool_calling" in t["name"] and "code_execution" in t["name"]
        ]

        if tool_name in prog_tool_names:
            # Execute programmatic_tool_calling via parent MCPTool
            # Note: The code execution will return a JSON with tool_calls that need execution
            tool_parsed, has_error, observation, returned_name, returned_id = (
                super().execute_tool(tool_name, parameters, tool_call_id)
            )

            if not tool_parsed:
                return (tool_parsed, has_error, observation, returned_name, returned_id)

            # Parse the result to execute any nested tool calls
            try:
                import json
                result = json.loads(observation)

                # Multi-pass execution: keep running until no more tools need execution
                max_passes = 10  # Prevent infinite loops
                pass_count = 0

                while result.get("needs_tool_execution", False) and pass_count < max_passes:
                    pass_count += 1

                    # Build tool_results_cache from executed tools
                    tool_results_cache = {}

                    # Execute each pending tool call
                    for tc in result.get("tool_calls", []):
                        tc_name = tc["tool_name"]
                        tc_args = tc["args"]
                        tc_id = tc["tool_call_id"]

                        # Try to execute the tool
                        executed = False

                        # Mode 1: Try other_tools first (multi-tool mode)
                        if self._other_tools:
                            for other_tool in self._other_tools:
                                tc_parsed, tc_error, tc_obs, tc_ret_name, tc_ret_id = (
                                    other_tool.execute_tool(tc_name, tc_args, tc_id)
                                )
                                if tc_parsed:
                                    # Cache the result
                                    tool_results_cache[tc_id] = tc_obs
                                    executed = True
                                    break

                        # Mode 2: Try self (single-tool mode with multiple servers)
                        if not executed:
                            # Use parent MCPTool to execute (same instance, different server)
                            tc_parsed, tc_error, tc_obs, tc_ret_name, tc_ret_id = (
                                super().execute_tool(tc_name, tc_args, tc_id)
                            )
                            if tc_parsed:
                                # Cache the result
                                tool_results_cache[tc_id] = tc_obs
                                executed = True

                        if not executed:
                            # Tool not found
                            tool_results_cache[tc_id] = f"[Error: Tool '{tc_name}' not found]"

                    # Re-execute code with cached tool results
                    new_params = parameters.copy()
                    new_params["tool_results_cache"] = tool_results_cache

                    tc_parsed, tc_error, observation, tc_ret_name, tc_ret_id = (
                        super(ProgrammaticToolCallingTool, self).execute_tool(
                            tool_name, new_params, tool_call_id
                        )
                    )

                    if not tc_parsed:
                        # Execution failed, return error
                        return (tc_parsed, tc_error, observation, tc_ret_name, tc_ret_id)

                    # Parse new result
                    result = json.loads(observation)

                # Final result - filter out internal fields that model shouldn't see
                filtered_result = {
                    k: v for k, v in result.items()
                    if k not in ["tool_calls", "tool_results", "file_path", "needs_tool_execution"]
                }
                observation = json.dumps(filtered_result, indent=2)

            except (json.JSONDecodeError, KeyError, TypeError) as e:
                # If parsing fails, return original observation
                import traceback
                error_info = {
                    "error": f"Failed to parse programmatic tool calling result: {e}",
                    "traceback": traceback.format_exc(),
                    "original_observation": observation
                }
                observation = json.dumps(error_info, indent=2)
                has_error = True

            return (tool_parsed, has_error, observation, returned_name, returned_id)

        else:
            # This is not programmatic_tool_calling, pass through to other tools
            # Try multi-tool mode first (self._other_tools)
            if self._other_tools:
                for other_tool in self._other_tools:
                    result = other_tool.execute_tool(tool_name, parameters, tool_call_id)
                    if result[0]:  # tool_parsed
                        return result

            # Try single-tool mode (super() - same instance with multiple servers)
            return super().execute_tool(tool_name, parameters, tool_call_id)


def get_programmatic_tool_calling_stdio_config(
    workspace_path: Optional[str] = None,
    workspace_dir: Optional[str] = None,
    server_name: str = "programmatic_tool_calling"
) -> dict:
    """Get Programmatic Tool Calling stdio server configuration (without creating MCPTool).

    Returns a config dict that can be merged with other server configs
    before creating a ProgrammaticToolCallingTool instance.

    Args:
        workspace_path: Path to the agent workspace directory (default: current directory)
        workspace_dir: Alias for workspace_path (for backward compatibility)
        server_name: Name for this server in the config (default: "programmatic_tool_calling")

    Returns:
        Dict with single server config: {server_name: {...}}

    Examples:
        # Get individual configs
        prog_config = get_programmatic_tool_calling_stdio_config(workspace_path="/path/to/workspace")
        claim_done_config = get_claim_done_stdio_config()

        # Merge configs
        merged_config = {
            "mcpServers": {
                **prog_config,
                **claim_done_config
            }
        }

        # Create combined tool with executor
        tool = ProgrammaticToolCallingTool(merged_config, tool_executor=my_executor, validate_on_init=False)
    """
    # Get path to programmatic_tool_calling server script
    server_script = Path(__file__).parent / "server.py"

    if not server_script.exists():
        raise FileNotFoundError(
            f"Programmatic Tool Calling server script not found at: {server_script}"
        )

    # Support both workspace_path and workspace_dir for backward compatibility
    workspace = workspace_dir if workspace_dir is not None else workspace_path
    if workspace is None:
        workspace = "."

    # Convert workspace path to absolute path
    abs_workspace = str(Path(workspace).absolute())

    # Build command arguments - pass workspace via command line argument
    args = [
        str(server_script),
        "--workspace", abs_workspace
    ]

    # Return single server config (without mcpServers wrapper)
    # Set cwd so that native Python file operations (like open()) use the workspace directory
    return {
        server_name: {
            "command": "python",
            "args": args,
            "cwd": abs_workspace,
            "env": {
                "PROGRAMMATIC_TOOL_CALLING_WORKSPACE": abs_workspace,
                "LOCA_QUIET": "1",
            }
        }
    }


def create_programmatic_tool_calling_tool_stdio(
    workspace_path: Optional[str] = None,
    workspace_dir: Optional[str] = None,
    tools: Optional[List[Any]] = None,
    validate_on_init: bool = False,
    **kwargs
) -> ProgrammaticToolCallingTool:
    """Create a Programmatic Tool Calling MCP tool using stdio transport.

    Provides a 'programmatic_tool_calling' tool that executes Python code with
    embedded tool calling capabilities. When code execution encounters a tool call,
    the tool records it, executes it via other tools in the environment, and
    continues with the result through multi-pass execution.

    This starts the Programmatic Tool Calling server as a subprocess and connects via stdio.

    Args:
        workspace_path: Path to the agent workspace directory (default: current directory)
        workspace_dir: Alias for workspace_path (for backward compatibility)
        tools: Optional list of other tools that can be called.
               Use tool.set_tools(tools) after creation to update.
        validate_on_init: Whether to validate the connection on initialization.
                         Set to False for faster startup.
        **kwargs: Additional arguments to pass to ProgrammaticToolCallingTool constructor

    Returns:
        ProgrammaticToolCallingTool configured for Programmatic Tool Calling server via stdio

    Example:
        >>> from gem.tools.mcp_server.programmatic_tool_calling import create_programmatic_tool_calling_tool_stdio
        >>> from gem.tools.mcp_server.filesystem import create_filesystem_tool
        >>>
        >>> # Create other tools first
        >>> filesystem_tool = create_filesystem_tool(agent_workspace="/path/to/workspace")
        >>>
        >>> # Create programmatic tool and set tools
        >>> prog_tool = create_programmatic_tool_calling_tool_stdio(
        >>>     workspace_path="/path/to/workspace"
        >>> )
        >>> prog_tool.set_tools([filesystem_tool])  # Set after creation
        >>>
        >>> # Or pass tools during creation
        >>> prog_tool = create_programmatic_tool_calling_tool_stdio(
        >>>     workspace_path="/path/to/workspace",
        >>>     tools=[filesystem_tool]
        >>> )
        >>>
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[filesystem_tool, prog_tool])
        >>>
        >>> # After adding to ToolEnvWrapper, update tool references
        >>> prog_tool.set_tools(env.tools)  # Now it can call all tools in env
        >>>
        >>> # Example code that uses tools programmatically:
        >>> code = '''
        >>> # Get file list
        >>> files = tools.list_files(path=".")
        >>> print(f"Found files: {files}")
        >>>
        >>> # Read first file
        >>> content = tools.read_file(path=files[0])
        >>> print(f"Content: {content}")
        >>>
        >>> result = "Success"
        >>> '''
    """
    # Get server config
    server_config = get_programmatic_tool_calling_stdio_config(
        workspace_path=workspace_path,
        workspace_dir=workspace_dir
    )

    # Wrap in mcpServers
    config = {"mcpServers": server_config}

    return ProgrammaticToolCallingTool(
        config,
        tools=tools,
        validate_on_init=validate_on_init,
        **kwargs
    )


def create_programmatic_tool_calling_tool_http(
    host: str = "127.0.0.1",
    port: int = 8085,
    tools: Optional[List[Any]] = None,
    validate_on_init: bool = True,
    **kwargs
) -> ProgrammaticToolCallingTool:
    """Create a Programmatic Tool Calling MCP tool using HTTP transport.

    Note: You need to start the Programmatic Tool Calling server separately:
        python -m gem.tools.mcp_server.programmatic_tool_calling.server --transport streamable-http --port 8085 --workspace /path/to/workspace

    Args:
        host: Server host (default: 127.0.0.1)
        port: Server port (default: 8085)
        tools: Optional list of other tools. Can be set later using tool.set_tools().
        validate_on_init: Whether to validate the connection on initialization
        **kwargs: Additional arguments to pass to ProgrammaticToolCallingTool constructor

    Returns:
        ProgrammaticToolCallingTool configured for Programmatic Tool Calling server via HTTP

    Example:
        >>> from gem.tools.mcp_server.programmatic_tool_calling import create_programmatic_tool_calling_tool_http
        >>> tool = create_programmatic_tool_calling_tool_http(port=8085, tools=[filesystem_tool])
        >>> # Use in environment
        >>> env = ToolEnvWrapper(env, tools=[tool])
    """
    url = f"http://{host}:{port}"

    # Create config for HTTP transport
    config = {"mcpServers": {
        "programmatic_tool_calling": {
            "url": url
        }
    }}

    return ProgrammaticToolCallingTool(
        config,
        tools=tools,
        validate_on_init=validate_on_init,
        **kwargs
    )
