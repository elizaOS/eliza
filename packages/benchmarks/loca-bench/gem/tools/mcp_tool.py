# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""MCP Tool implementation for connecting to any MCP server."""

import asyncio
import io
import json
import logging
import os
import re
import sys
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from fastmcp import Client
from fastmcp.client.auth import BearerAuth
from fastmcp.client.logging import LogMessage
from fastmcp.client.sampling import RequestContext, SamplingMessage, SamplingParams
from fastmcp.exceptions import ClientError

from gem.tools.base_tool import BaseTool

logger = logging.getLogger(__name__)
# silence the underlying HTTP and MCP client loggers
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("mcp.client.streamable_http").setLevel(logging.WARNING)
logging.getLogger("fastmcp").setLevel(logging.WARNING)
logging.getLogger("fastmcp.client.client").setLevel(logging.CRITICAL)  # Suppress "Field names must not be keywords" errors
logging.getLogger("mcp").setLevel(logging.WARNING)
logging.getLogger("asyncio").setLevel(logging.WARNING)


# Roots handler that returns an empty list - this properly responds to server's roots/list request
def _empty_roots_handler(context: Any) -> List[str]:
    """Return an empty roots list to satisfy MCP roots/list requests."""
    return []


# In quiet mode, redirect MCP server stderr to /dev/null
# This suppresses console.error messages from npm packages that we can't control
def _patch_stdio_transport_for_quiet_mode() -> None:
    """Patch StdioMCPServer to redirect stderr to /dev/null when LOCA_QUIET is set."""
    try:
        from fastmcp.mcp_config import StdioMCPServer
        from fastmcp.client.transports import StdioTransport
        from pathlib import Path

        _original_to_transport = StdioMCPServer.to_transport

        def _patched_to_transport(self) -> StdioTransport:
            quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
            log_file = Path('/dev/null') if quiet else None
            return StdioTransport(
                command=self.command,
                args=self.args,
                env=self.env,
                cwd=self.cwd,
                log_file=log_file,
            )

        StdioMCPServer.to_transport = _patched_to_transport
    except ImportError:
        pass  # FastMCP not available


_patch_stdio_transport_for_quiet_mode()


class _StreamFilter(io.TextIOWrapper):
    """Filter a stream to suppress harmless MCP server warnings and startup messages.

    The @modelcontextprotocol/server-filesystem npm package prints
    "Failed to request initial roots from client" warnings that are
    harmless but noisy. FastMCP also prints startup messages to stderr.
    This filter suppresses them.
    """

    # Patterns to suppress (harmless MCP startup messages and npm noise)
    SUPPRESSED_PATTERNS = [
        "Starting MCP server",
        "with transport 'stdio'",
        "MCP Server running on stdio",
        "Knowledge Graph MCP Server",
        "npm notice",  # Suppress npm update notices
        "New minor version of npm available",
    ]

    def __init__(self, original_stream: io.TextIOBase):
        self._original_stream = original_stream
        self._buffer = ""

    def write(self, text: str) -> int:
        # Check if text contains any suppressed patterns
        for pattern in self.SUPPRESSED_PATTERNS:
            if pattern in text:
                return len(text)  # Pretend we wrote it
        return self._original_stream.write(text)

    def flush(self) -> None:
        self._original_stream.flush()

    def fileno(self) -> int:
        return self._original_stream.fileno()

    def isatty(self) -> bool:
        return self._original_stream.isatty()

    def __getattr__(self, name: str) -> Any:
        # Delegate other attributes to original stderr
        return getattr(self._original_stream, name)


def _install_stream_filters() -> None:
    """Install stdout/stderr filters to suppress harmless MCP warnings and startup messages."""
    if not isinstance(sys.stderr, _StreamFilter):
        sys.stderr = _StreamFilter(sys.stderr)  # type: ignore[assignment]
    if not isinstance(sys.stdout, _StreamFilter):
        sys.stdout = _StreamFilter(sys.stdout)  # type: ignore[assignment]


# Install the filters when this module is imported
_install_stream_filters()


# Global event loop for MCP operations to avoid "Event loop is closed" errors
_global_loop = None
_global_loop_lock = threading.Lock()

def _get_or_create_global_loop():
    """Get or create a global event loop for MCP operations."""
    global _global_loop
    with _global_loop_lock:
        if _global_loop is None or _global_loop.is_closed():
            _global_loop = asyncio.new_event_loop()
        return _global_loop

def _run_async(coro):
    """Run an async coroutine from both sync and already-async contexts safely.

    - If there is no running loop, uses a persistent global loop
    - If called inside a running loop, spins up a dedicated thread with its own loop
    """
    # Try to detect if there's a running event loop
    # Need to check both get_running_loop() AND loop.is_running() for uvloop compatibility
    in_running_loop = False
    running_loop = None
    
    try:
        running_loop = asyncio.get_running_loop()
        # If we got a loop, check if it's actually running (important for uvloop)
        if running_loop is not None and running_loop.is_running():
            in_running_loop = True
    except RuntimeError:
        # No running loop detected
        pass

    # Additional check: even if we got a loop from the global dict, verify it's not running
    if not in_running_loop:
        try:
            loop = _get_or_create_global_loop()
            # Double-check the loop isn't already running (uvloop safety)
            if loop.is_running():
                in_running_loop = True
            else:
                # Safe to use this loop
                return loop.run_until_complete(coro)
        except RuntimeError as e:
            # If we get here, the loop is running - use thread approach
            logger.debug(f"Loop is running, switching to thread approach: {e}")
            in_running_loop = True

    # There's a running loop - execute in separate thread with new loop
    result: Dict[str, Any] = {}

    def _runner():
        try:
            # Create a fresh event loop for this thread
            # Don't reuse global loop to avoid conflicts
            new_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(new_loop)
            try:
                result["value"] = new_loop.run_until_complete(coro)
            finally:
                # Minimal cleanup - let FastMCP client close connections properly
                # Don't aggressively cancel tasks or close loop immediately
                try:
                    # Only shutdown async generators
                    new_loop.run_until_complete(new_loop.shutdown_asyncgens())
                except Exception:
                    pass
                # Don't close the loop immediately - let it be garbage collected
                # This allows FastMCP client background tasks to complete naturally
        except Exception as exc:  # noqa: BLE001
            result["error"] = exc

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    thread.join(timeout=300)  # Add timeout to prevent hanging forever
    
    if thread.is_alive():
        # Thread still running after timeout
        raise TimeoutError("MCP tool execution timed out in thread")

    if "error" in result:
        raise result["error"]
    return result.get("value")


def is_timeout_error(error: Exception) -> bool:
    """Check if an error is a timeout-related error."""
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return True
    error_str = str(error).lower()
    return any(
        keyword in error_str
        for keyword in ["etimedout", "econnreset", "timeout", "timed out"]
    )


class MCPTool(BaseTool):
    """A tool for connecting to MCP servers.

    This tool provides a unified configuration-based interface to connect to and
    interact with MCP servers following the GEM framework's BaseTool interface.

    Uses FastMCP client with configuration-based setup for reliable MCP
    communication. Supports both simple HTTP servers and complex multi-server
    configurations.

    Examples:
        # Simple HTTP server (most common case)
        tool = MCPTool("https://api.example.com/mcp")

        # HTTP server with authentication
        tool = MCPTool({
            "mcpServers": {
                "main": {
                    "transport": "http",
                    "url": "https://api.example.com/mcp",
                    "headers": {"Authorization": "Bearer your-token"}
                }
            }
        })

        # Multi-server configuration with tool transformations
        tool = MCPTool({
            "mcpServers": {
                "weather": {
                    "transport": "http",
                    "url": "https://weather-api.example.com/mcp"
                },
                "assistant": {
                    "transport": "http",
                    "url": "https://assistant-api.example.com/mcp",
                    "tools": {
                        "ask": {"name": "assistant_ask"}  # Rename tool
                    }
                }
            }
        })

        # From configuration file
        tool = MCPTool.from_config_file("mcp_servers.json")

        # HTTP with custom authentication and callbacks
        tool = MCPTool(
            "https://api.example.com/mcp",
            auth="bearer-token",
            headers={"X-Custom": "value"},
            log_handler=my_log_handler
        )

        # Local stdio MCP server (spawned via command)
        tool = MCPTool.from_local_command({
            "command": "pipx",
            "args": ["run", "postgres-mcp-server", "postgresql://..."]
        })

        # Inline config with local stdio server (transport will default to 'stdio')
        tool = MCPTool({
            "mcpServers": {
                "db": {
                    "command": "pipx",
                    "args": ["run", "postgres-mcp-server", "postgresql://..."]
                }
            }
        })
    """

    tool_type = "mcp"

    def __init__(
        self,
        config: Union[str, Dict[str, Any]],
        # Optional authentication and headers for simple HTTP case
        auth: Optional[Union[str, BearerAuth]] = None,
        headers: Optional[Dict[str, str]] = None,
        # Optional callback handlers
        log_handler: Optional[Callable[[LogMessage], None]] = None,
        progress_handler: Optional[
            Callable[[float, Optional[float], Optional[str]], None]
        ] = None,
        sampling_handler: Optional[
            Callable[[List[SamplingMessage], SamplingParams, RequestContext], str]
        ] = None,
        # Retry and timeout configuration
        max_retries: int = 3,
        delay_between_retries: float = 1.0,
        execution_timeout: float = 30.0,
        validate_on_init: bool = True,
        num_workers: int = 1,
        # Schema fixing for OpenAI compatibility
        fix_schema_for_openai: bool = False,
    ):
        """Initialize the MCP tool using configuration.

        Args:
            config: MCP server configuration. Can be:
                - URL string: "https://api.example.com/mcp" (auto-converted to config)
                - MCP config dict: Full configuration with multiple servers
            auth: Bearer token for authentication (only used with URL string input)
            headers: Custom headers for HTTP requests (only used with URL string input)
            log_handler: Handler for server log messages
            progress_handler: Handler for progress updates during long operations
            sampling_handler: Handler for server LLM sampling requests
            max_retries: Maximum number of retry attempts on failure
            delay_between_retries: Delay in seconds between retry attempts
            execution_timeout: Timeout in seconds for tool execution
            num_workers: Number of worker processes
            fix_schema_for_openai: Whether to fix JSON schemas for OpenAI API compatibility
        """
        super().__init__(num_workers)

        # Store original config and normalize it
        self.raw_config = config
        self.normalized_config = self._normalize_config(config, auth, headers)

        # Create FastMCP client with normalized configuration
        self.client = self._create_client(
            log_handler, progress_handler, sampling_handler, execution_timeout
        )

        # Retry and timeout configuration
        self.max_retries = max_retries
        self.delay_between_retries = delay_between_retries
        self.execution_timeout = execution_timeout
        
        # Schema fixing configuration
        self.fix_schema_for_openai = fix_schema_for_openai

        # Store initialization parameters for reconfiguration
        self._log_handler = log_handler
        self._progress_handler = progress_handler
        self._sampling_handler = sampling_handler

        # Tool discovery and caching
        self._available_tools: Optional[List[Dict[str, Any]]] = None
        self._tools_discovered = False
        self._discovery_lock = threading.Lock()  # Protect tool discovery
        self._tool_execution_lock = None  # Async lock for tool execution, created lazily

        # Perform sanity check unless explicitly disabled
        if validate_on_init:
            try:
                tools = self.get_available_tools()
                if not tools:
                    raise ValueError(
                        f"No tools available from MCP server(s). "
                        f"Please check your server configuration: {self._get_server_description()}"
                    )
            except Exception as e:
                # Re-raise with more context if it's not already our custom error
                if "No tools available" not in str(e):
                    raise ValueError(
                        f"Failed to connect to MCP server(s): {e}. "
                        f"Server configuration: {self._get_server_description()}"
                    ) from e
                raise

    def _normalize_config(
        self,
        config: Union[str, Dict[str, Any]],
        auth: Optional[Union[str, BearerAuth]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Convert any config input to standard MCP configuration format.

        Args:
            config: URL string or MCP configuration dictionary
            auth: Optional authentication for URL string input
            headers: Optional headers for URL string input

        Returns:
            Standard MCP configuration dictionary
        """
        if isinstance(config, str):
            # Auto-convert URL string to simple HTTP config
            server_config = {"transport": "http", "url": config}

            # Add authentication if provided
            if auth or headers:
                server_headers = headers or {}
                if auth:
                    if isinstance(auth, str):
                        server_headers["Authorization"] = f"Bearer {auth}"
                    # BearerAuth will be handled in client creation
                if server_headers:
                    server_config["headers"] = server_headers

            return {"mcpServers": {"default": server_config}}
        elif isinstance(config, dict):
            # If it's already an mcpServers map, normalize each server entry
            if "mcpServers" in config:
                normalized = config.copy()
                for _, server_config in normalized["mcpServers"].items():
                    if "transport" not in server_config:
                        # Infer transport: stdio when command/args present; otherwise http
                        if ("command" in server_config) or ("args" in server_config):
                            server_config["transport"] = "stdio"
                        else:
                            server_config["transport"] = "http"
                return normalized

            # Otherwise treat the dict as a single server_params entry
            server_config = config.copy()
            if "transport" not in server_config:
                if ("command" in server_config) or ("args" in server_config):
                    server_config["transport"] = "stdio"
                else:
                    server_config["transport"] = "http"
            return {"mcpServers": {"default": server_config}}
        else:
            raise ValueError(f"Unsupported config type: {type(config)}")

    def _create_client(
        self,
        log_handler: Optional[Callable[[LogMessage], None]],
        progress_handler: Optional[
            Callable[[float, Optional[float], Optional[str]], None]
        ],
        sampling_handler: Optional[
            Callable[[List[SamplingMessage], SamplingParams, RequestContext], str]
        ],
        timeout: float,
    ) -> Client:
        """Create FastMCP client with normalized configuration."""
        # If no log_handler provided, use a silent handler by default
        if log_handler is None:
            log_handler = (
                lambda _: None
            )  # Silent handler - does nothing with log messages

        client_kwargs = {
            "timeout": timeout,
            "log_handler": log_handler,
            # Provide a roots handler that returns empty list to properly respond
            # to server's roots/list request (prevents "Failed to request initial roots" error)
            "roots": _empty_roots_handler,
        }

        # Add optional handlers if provided
        if progress_handler:
            client_kwargs["progress_handler"] = progress_handler
        if sampling_handler:
            client_kwargs["sampling_handler"] = sampling_handler

        return Client(self.normalized_config, **client_kwargs)

    def _discover_tools(self) -> List[Dict[str, Any]]:
        """Discover available tools from the MCP server (synchronous wrapper)."""
        # Thread-safe tool discovery
        with self._discovery_lock:
            if self._tools_discovered:
                return self._available_tools or []

            print(f"[MCP] Discovering tools from servers...")
            tools = _run_async(self._async_discover_tools())
            self._available_tools = tools
            self._tools_discovered = True
            print(f"[MCP] Discovered {len(tools)} tools")
            if tools:
                tool_names = [t['name'] for t in tools[:5]]  # Show first 5
                print(f"[MCP] Sample tools: {tool_names}")
            return tools

    async def _async_discover_tools(self) -> List[Dict[str, Any]]:
        """Discover tools using fastMCP client."""
        tools: List[Dict[str, Any]] = []

        for attempt in range(self.max_retries):
            try:
                # Must use async with to establish connection
                # This works in our thread approach as long as enter/exit happens in same task
                async with self.client:
                    mcp_tools = await self.client.list_tools()
                    is_multi = self._is_multi_server()
                    server_names = self._get_server_names()

                    for tool in mcp_tools:
                        # FastMCP client should already return prefixed names for multi-server configs
                        # but we'll add server info for debugging and clarity
                        tool_name = tool.name
                        server_info = {
                            "is_multi_server": is_multi,
                            "servers": server_names,
                        }

                        # Try to detect which server this tool belongs to
                        if is_multi:
                            detected_server = None
                            for server_name in server_names:
                                if tool_name.startswith(f"{server_name}_"):
                                    detected_server = server_name
                                    break
                            server_info["detected_server"] = detected_server
                        else:
                            server_info["detected_server"] = (
                                server_names[0] if server_names else "default"
                            )

                        tool_info = {
                            "name": tool_name,
                            "description": tool.description or "",
                            "parameters": tool.inputSchema,
                            "server_info": server_info,
                        }
                        tools.append(tool_info)
                # Exit async with before break - ensures proper cleanup
                break

            except Exception as e:  # noqa: BLE001
                logger.warning(f"Tool discovery attempt {attempt + 1} failed: {e}")
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(self.delay_between_retries)
                else:
                    logger.error(
                        f"Failed to discover tools after {self.max_retries} attempts"
                    )

        return tools

    def get_available_tools(self) -> List[Dict[str, Any]]:
        """Get list of available tools from the MCP server."""
        return self._discover_tools()

    def _parse_action(self, action: str) -> Tuple[str, str, Dict[str, Any], bool]:
        """Parse action to extract tool name and parameters.

        Expected format: <tool_call><tool_name>tool_name</tool_name><arguments>{"param1": "value1"}</arguments></tool_call>

        Args:
            action: Raw action string from agent

        Returns:
            tuple: (tool_name, parsed_action, parameters_dict, is_valid)
        """
        # New XML format pattern
        pattern = r"<tool_call>\s*<tool_name>([^<]+)</tool_name>\s*<arguments>(.*?)</arguments>\s*</tool_call>"
        match = re.search(pattern, action, re.DOTALL)

        if not match:
            return "", "", {}, False

        tool_name = match.group(1).strip()
        params_str = match.group(2).strip()
        parsed_action = match.group(0)

        try:
            if params_str:
                parameters = json.loads(params_str)
            else:
                parameters = {}
            return tool_name, parsed_action, parameters, True
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse parameters JSON: {e}")
            return tool_name, parsed_action, {}, False

    def _execute_mcp_tool(self, tool_name: str, parameters: Dict[str, Any]) -> str:
        """Execute a specific MCP tool with given parameters (synchronous wrapper)."""
        return _run_async(self._async_execute_tool(tool_name, parameters))

    async def _async_execute_tool(
        self, tool_name: str, parameters: Dict[str, Any]
    ) -> str:
        """Execute tool using FastMCP client with enhanced result handling."""
        # Create async lock lazily (must be in async context)
        if self._tool_execution_lock is None:
            self._tool_execution_lock = asyncio.Lock()
        
        # Serialize tool executions for this MCPTool instance to avoid stdio connection conflicts
        async with self._tool_execution_lock:
            for attempt in range(self.max_retries):
                try:
                    # Recreate client on retry attempts to handle stdio connection issues
                    if attempt > 0:
                        # TODO: @changyu check if this is necessary
                        logger.info(f"Recreating client for retry attempt {attempt + 1}")
                        self.client = self._create_client(
                            (
                                self.client._log_handler
                                if hasattr(self.client, "_log_handler")
                                else None
                            ),
                            (
                                self.client._progress_handler
                                if hasattr(self.client, "_progress_handler")
                                else None
                            ),
                            (
                                self.client._sampling_handler
                                if hasattr(self.client, "_sampling_handler")
                                else None
                            ),
                            self.execution_timeout,
                        )

                    # Must use async with to establish connection
                    # This works in our thread approach as long as enter/exit happens in same task
                    async with self.client:
                        result = await self.client.call_tool(
                            tool_name,
                            parameters,
                            timeout=self.execution_timeout,
                            raise_on_error=False,
                        )

                        # Check for errors using FastMCP's structured error detection
                        if result.is_error:
                            error_content = []
                            for content in result.content:
                                if hasattr(content, "text"):
                                    error_content.append(content.text)
                                else:
                                    error_content.append(str(content))
                            error_msg = ' '.join(error_content)
                            
                            # Special handling for "Unknown tool" errors
                            if "Unknown tool" in error_msg or "unknown tool" in error_msg.lower():
                                # This means FastMCP client doesn't recognize the tool
                                # Force re-discovery on next call (thread-safe)
                                print(f"[MCP] ⚠️ FastMCP client doesn't recognize tool: {tool_name}")
                                print(f"[MCP] Clearing tool cache to force re-discovery...")
                                with self._discovery_lock:
                                    self._tools_discovered = False
                                    self._available_tools = None
                            
                            return f"[Tool execution error: {error_msg}]"

                        # Log success if this was a retry attempt
                        if attempt > 0:
                            logger.info(
                                f"Tool execution succeeded on attempt {attempt + 1}"
                            )

                        # Use FastMCP's structured data handling
                        if result.data is not None:
                            # FastMCP provides fully hydrated Python objects
                            return str(result.data)
                        elif result.content:
                            # Fallback to content blocks when no structured data
                            parts = []
                            for content in result.content:
                                if hasattr(content, "text"):
                                    parts.append(content.text)
                                elif hasattr(content, "data"):
                                    parts.append(f"Binary data: {len(content.data)} bytes")
                                else:
                                    parts.append(str(content))
                            return "\n".join(parts)
                        else:
                            # No content available
                            return "Tool execution completed with no output"

                except ClientError as e:
                    error_str = str(e)
                    # Retry on connection failures
                    if (
                        "failed to connect" in error_str.lower()
                        and attempt < self.max_retries - 1
                    ):
                        logger.warning(
                            f"Tool execution attempt {attempt + 1} failed with connection error: {e}"
                        )
                        await asyncio.sleep(self.delay_between_retries)
                        continue
                    else:
                        error_msg = f"[Tool execution error: {e}]"
                        logger.error(error_msg)
                        return error_msg

                except BlockingIOError as e:
                    # Handle "[Errno 11] write could not complete without blocking"
                    # This is a known issue with fastmcp's stdio transport
                    if attempt < self.max_retries - 1:
                        logger.warning(
                            f"Tool execution attempt {attempt + 1} failed with BlockingIOError: {e}"
                        )
                        await asyncio.sleep(self.delay_between_retries * 2)  # Longer delay for I/O issues
                        continue
                    else:
                        error_msg = f"[Tool execution failed (BlockingIOError): {e}]"
                        logger.error(error_msg)
                        return error_msg

                except Exception as e:  # noqa: BLE001
                    error_str = str(e)
                    # Also retry on BlockingIOError wrapped in other exceptions
                    is_blocking_io = (
                        isinstance(e.__cause__, BlockingIOError) or
                        "write could not complete without blocking" in error_str or
                        "Errno 11" in error_str
                    )
                    should_retry = (
                        is_timeout_error(e) or 
                        "failed to connect" in error_str.lower() or
                        is_blocking_io
                    ) and attempt < self.max_retries - 1
                    if should_retry:
                        delay = self.delay_between_retries * 2 if is_blocking_io else self.delay_between_retries
                        logger.warning(f"Tool execution attempt {attempt + 1} failed: {e}")
                        await asyncio.sleep(delay)
                        continue
                    else:
                        error_msg = f"[Tool execution failed: {e}]"
                        logger.error(error_msg)
                        return error_msg

            return "[Tool execution failed after all retry attempts]"

    @classmethod
    def from_url(
        cls,
        url: str,
        auth: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
        **kwargs,
    ) -> "MCPTool":
        """Create MCPTool for HTTP server with authentication.

        Args:
            url: HTTP URL of the MCP server
            auth: Bearer token for authentication
            headers: Custom headers to send with requests
            **kwargs: Additional arguments to pass to MCPTool constructor

        Returns:
            MCPTool instance configured for HTTP transport
        """
        return cls(config=url, auth=auth, headers=headers, **kwargs)

    @classmethod
    def from_config_file(cls, config_path: str, **kwargs) -> "MCPTool":
        """Create MCPTool from MCP configuration file.

        Args:
            config_path: Path to MCP configuration JSON file
            **kwargs: Additional arguments to pass to MCPTool constructor

        Returns:
            MCPTool instance configured from the file
        """
        with open(config_path, "r") as f:
            config = json.load(f)

        return cls(config=config, **kwargs)

    @classmethod
    def from_local_command(
        cls,
        server_params: Dict[str, Any],
        name: str = "default",
        **kwargs,
    ) -> "MCPTool":
        """Create MCPTool for a local stdio MCP server spawned by a command.

        The server_params should include at least:
        - command: The executable to run (e.g., "pipx")
        - args: A list of arguments (e.g., ["run", "postgres-mcp-server", "postgresql://..."])
        Optionally include "env" or other fields supported by FastMCP.

        Args:
            server_params: Parameters defining how to spawn the server process
            name: Logical server name used when multiple servers are configured
            **kwargs: Additional arguments to pass to MCPTool constructor

        Returns:
            MCPTool instance configured for stdio transport
        """
        config = {"mcpServers": {name: server_params}}
        return cls(config=config, **kwargs)

    @classmethod
    def from_multi_server(cls, servers: Dict[str, str], **kwargs) -> "MCPTool":
        """Create MCPTool for multiple HTTP servers.

        Args:
            servers: Dictionary mapping server names to URLs
            **kwargs: Additional arguments to pass to MCPTool constructor

        Returns:
            MCPTool instance configured for multiple servers
        """
        config = {
            "mcpServers": {
                name: {"transport": "http", "url": url} for name, url in servers.items()
            }
        }
        return cls(config=config, **kwargs)

    @classmethod
    def from_gem_servers(
        cls,
        canvas: bool = True,
        memory: bool = True,
        claim_done: bool = True,
        python_execute: bool = True,
        canvas_data_dir: Optional[str] = None,
        canvas_login_id: Optional[str] = None,
        canvas_password: Optional[str] = None,
        memory_file_path: Optional[str] = None,
        workspace_path: Optional[str] = None,
        validate_on_init: bool = False,
        **kwargs
    ) -> "MCPTool":
        """Create MCPTool with all gem MCP servers (Canvas, Memory, ClaimDone, PythonExecute).
        
        This is a convenience method that creates a single MCPTool instance with access to
        all standard gem MCP servers. All servers auto-start via stdio transport.
        
        Args:
            canvas: Include Canvas server (default: True)
            memory: Include Memory server (default: True)
            claim_done: Include ClaimDone server (default: True)
            python_execute: Include PythonExecute server (default: True)
            canvas_data_dir: Path to Canvas data directory (default: ./canvas_data)
            canvas_login_id: Optional auto-login user ID for Canvas
            canvas_password: Optional auto-login password for Canvas
            memory_file_path: Path to Memory JSON file (default: ./memory.json)
            workspace_path: Path to workspace for Python execution (default: current directory)
            validate_on_init: Whether to validate on initialization (default: False)
            **kwargs: Additional arguments to pass to MCPTool constructor
        
        Returns:
            MCPTool instance with all selected gem servers configured
        
        Examples:
            # All servers with defaults
            >>> tool = MCPTool.from_gem_servers()
            
            # Only specific servers
            >>> tool = MCPTool.from_gem_servers(
            ...     canvas=True,
            ...     memory=False,
            ...     claim_done=True,
            ...     python_execute=True
            ... )
            
            # With custom configurations
            >>> tool = MCPTool.from_gem_servers(
            ...     canvas_data_dir="/path/to/canvas_data",
            ...     canvas_login_id="student1",
            ...     canvas_password="password123",
            ...     memory_file_path="/path/to/memory.json",
            ...     workspace_path="/path/to/workspace"
            ... )
            
            # Use in environment (single tool for all servers!)
            >>> env = ToolEnvWrapperClaimDone(env, tools=[tool], max_tool_uses=100)
            
            # Access tools with server prefixes:
            # - canvas_list_courses, canvas_get_assignments, etc.
            # - memory_create_entities, memory_search_nodes, etc.
            # - claim_done
            # - python_execute
        """
        from pathlib import Path
        
        config = {"mcpServers": {}}
        
        # Add Canvas server
        if canvas:
            # Setup Canvas data directory
            canvas_dir = canvas_data_dir or "./canvas_data"
            data_path = Path(canvas_dir)
            data_path.mkdir(parents=True, exist_ok=True)
            abs_canvas_dir = str(data_path.absolute())
            
            # Auto-detect Canvas server script
            current_file = Path(__file__)
            # Try gem/mcp_convert (local copy, preferred)
            canvas_script = current_file.parent.parent / "mcp_convert" / "mcps" / "canvas" / "server.py"
            if not canvas_script.exists():
                # Try mcpbench_dev/mcp_convert
                canvas_script = current_file.parent.parent / "mcpbench_dev" / "mcp_convert" / "mcps" / "canvas" / "server.py"
                if not canvas_script.exists():
                    raise ValueError(
                        "Cannot find Canvas server script. Expected at:\n"
                        "  - gem/mcp_convert/mcps/canvas/server.py (preferred)\n"
                        "  - mcpbench_dev/mcp_convert/mcps/canvas/server.py"
                    )
            
            # Build Canvas command arguments
            canvas_args = [str(canvas_script)]
            if canvas_login_id:
                canvas_args.extend(["--login_id", canvas_login_id])
            if canvas_password:
                canvas_args.extend(["--password", canvas_password])
            
            config["mcpServers"]["canvas"] = {
                "command": "python",
                "args": canvas_args,
                "env": {"CANVAS_DATA_DIR": abs_canvas_dir, "PYTHONUNBUFFERED": "1"}
            }
        
        # Add Memory server
        if memory:
            memory_path = Path(memory_file_path or "./memory.json")
            memory_path.parent.mkdir(parents=True, exist_ok=True)
            abs_memory_path = str(memory_path.absolute())
            
            config["mcpServers"]["memory"] = {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"],
                "env": {"MEMORY_FILE_PATH": abs_memory_path}
            }
        
        # Add ClaimDone server
        if claim_done:
            claim_done_script = Path(__file__).parent / "mcp_server" / "claim_done" / "server.py"
            if not claim_done_script.exists():
                raise ValueError(f"ClaimDone server script not found at: {claim_done_script}")
            
            config["mcpServers"]["claim_done"] = {
                "command": "python",
                "args": [str(claim_done_script), "--transport", "stdio"],
                "env": {"PYTHONUNBUFFERED": "1"}
            }
        
        # Add Python Execute server
        if python_execute:
            python_execute_script = Path(__file__).parent / "mcp_server" / "python_execute" / "server.py"
            if not python_execute_script.exists():
                raise ValueError(f"Python Execute server script not found at: {python_execute_script}")
            
            workspace = workspace_path or "."
            abs_workspace = str(Path(workspace).absolute())
            
            config["mcpServers"]["python_execute"] = {
                "command": "python",
                "args": [
                    str(python_execute_script),
                    "--transport", "stdio",
                    "--workspace", abs_workspace
                ],
                "env": {"PYTHONUNBUFFERED": "1"}
            }
        
        # Check that at least one server is enabled
        if not config["mcpServers"]:
            raise ValueError("At least one server must be enabled")
        
        return cls(config=config, validate_on_init=validate_on_init, **kwargs)

    def reconfigure(
        self,
        new_config: Union[str, Dict[str, Any]],
        auth: Optional[Union[str, BearerAuth]] = None,
        headers: Optional[Dict[str, str]] = None,
    ):
        """Reconfigure the MCP tool with new configuration.

        This method allows updating the configuration (e.g., database URL) and recreates
        the FastMCP client with the new settings. This is useful when the underlying
        service configuration changes during the tool's lifecycle.

        Args:
            new_config: New MCP server configuration (URL string or config dict)
            auth: Optional authentication for URL string input
            headers: Optional headers for URL string input
        """
        logger.info(f"Reconfiguring MCPTool with new configuration")

        # Close existing client if it exists
        self.close()

        # Update configuration
        self.raw_config = new_config
        self.normalized_config = self._normalize_config(new_config, auth, headers)

        # Recreate client with new configuration
        self.client = self._create_client(
            self._log_handler,
            self._progress_handler,
            self._sampling_handler,
            self.execution_timeout,
        )

        # Reset tool discovery cache to force re-discovery with new client (thread-safe)
        with self._discovery_lock:
            self._available_tools = None
            self._tools_discovered = False

        logger.info(
            f"MCPTool reconfiguration completed: {self._get_server_description()}"
        )

    def close(self):
        """Clean up resources including MCP server subprocesses."""
        try:
            if hasattr(self.client, "close"):
                _run_async(self.client.close())
        except Exception:
            # Ignore cleanup errors - the client may already be closed
            # or the event loop may have been closed
            pass

        # Forcefully terminate any remaining subprocess spawned by transports
        try:
            # Access internal transports to kill subprocesses
            if hasattr(self.client, "_transports"):
                for transport in self.client._transports.values():
                    if hasattr(transport, "_process") and transport._process is not None:
                        try:
                            transport._process.terminate()
                            transport._process.wait(timeout=1.0)
                        except Exception:
                            try:
                                transport._process.kill()
                            except Exception:
                                pass
        except Exception:
            pass

    def __del__(self):
        """Cleanup on deletion."""
        if hasattr(self, "client") and self.client:
            try:
                self.close()
            except Exception:
                # Ignore cleanup errors during deletion
                pass

    def _fix_json_schema(self, schema: Dict[str, Any]) -> Dict[str, Any]:
        """
        Fix JSON schema to ensure it's valid for OpenAI API.
        
        This recursively checks all schema definitions and ensures:
        - Arrays have proper 'items' definitions
        - All schema types are valid
        
        Args:
            schema: The JSON schema to fix
            
        Returns:
            Fixed JSON schema
        """
        if not isinstance(schema, dict):
            return schema
        
        # Create a copy to avoid modifying the original
        fixed_schema = schema.copy()
        
        # If this is an array type, ensure it has items defined
        if fixed_schema.get("type") == "array":
            if "items" not in fixed_schema or fixed_schema["items"] is None:
                # Add a default items schema if missing
                fixed_schema["items"] = {"type": "string"}
                logger.warning(
                    f"Array schema missing 'items' definition, added default: {{'type': 'string'}}"
                )
            elif isinstance(fixed_schema["items"], dict):
                # Recursively fix the items schema
                fixed_schema["items"] = self._fix_json_schema(fixed_schema["items"])
        
        # Recursively fix properties
        if "properties" in fixed_schema and isinstance(fixed_schema["properties"], dict):
            fixed_properties = {}
            for prop_name, prop_schema in fixed_schema["properties"].items():
                if isinstance(prop_schema, dict):
                    fixed_properties[prop_name] = self._fix_json_schema(prop_schema)
                else:
                    fixed_properties[prop_name] = prop_schema
            fixed_schema["properties"] = fixed_properties
        
        # Recursively fix nested schemas (oneOf, anyOf, allOf)
        for key in ["oneOf", "anyOf", "allOf"]:
            if key in fixed_schema and isinstance(fixed_schema[key], list):
                fixed_schema[key] = [
                    self._fix_json_schema(item) if isinstance(item, dict) else item
                    for item in fixed_schema[key]
                ]
        
        # Recursively fix additionalProperties
        if "additionalProperties" in fixed_schema:
            if isinstance(fixed_schema["additionalProperties"], dict):
                fixed_schema["additionalProperties"] = self._fix_json_schema(
                    fixed_schema["additionalProperties"]
                )
        
        return fixed_schema

    def get_tool_function(self) -> List[Dict[str, Any]]:
        """Get the tool function for the MCP tool."""
        tools = self.get_available_tools()
        tool_functions = []
        for tool in sorted(tools, key=lambda t: t.get("name", "")):
            # Enhance description with server information for multi-server configs
            description = tool["description"]
            server_info = tool.get("server_info", {})

            if server_info.get("is_multi_server") and server_info.get(
                "detected_server"
            ):
                server_name = server_info["detected_server"]
                description = (
                    f"[{server_name}] {description}"
                    if description
                    else f"[{server_name}] Tool from {server_name} server"
                )

            # Get parameters schema and optionally fix it for OpenAI
            parameters = tool.get("parameters", {"type": "object", "properties": {}})
            if self.fix_schema_for_openai:
                parameters = self._fix_json_schema(parameters)

            func_def = {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": description,
                    "parameters": parameters,
                },
            }
            tool_functions.append(func_def)
        return tool_functions

    def instruction_string(self) -> str:
        """Return instruction string for using the MCP tool."""
        tools = self.get_available_tools()

        # Convert tools to the required JSON format
        tool_functions = []
        for tool in sorted(tools, key=lambda t: t.get("name", "")):
            # Enhance description with server information for multi-server configs
            description = tool["description"]
            server_info = tool.get("server_info", {})

            if server_info.get("is_multi_server") and server_info.get(
                "detected_server"
            ):
                server_name = server_info["detected_server"]
                description = (
                    f"[{server_name}] {description}"
                    if description
                    else f"[{server_name}] Tool from {server_name} server"
                )

            func_def = {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": description,
                    "parameters": tool.get(
                        "parameters", {"type": "object", "properties": {}}
                    ),
                },
            }
            tool_functions.append(json.dumps(func_def))

        return (
            f"# Tool-Use Instructions\n\n"
            f"In this environment you have access to a set of tools you can use to answer the user's question.\n\n"
            f"You only have access to the tools provided below. You can only use one tool per message, and will receive the result of that tool in the user's next response. You use tools step-by-step to accomplish a given task, with each tool-use informed by the result of the previous tool-use.\n\n"
            f"Tool-use is formatted using XML-style tags. The tool-use is enclosed in <tool_call></tool_call> and each parameter is similarly enclosed within its own set of tags.\n\n"
            f"## Parameters\n"
            f"- tool_name: (required) The name of the tool to execute\n"
            f"- arguments: (required) A JSON object containing the tool's input parameters, following the tool's input schema. Quotes within strings must be properly escaped. Ensure the JSON is valid.\n\n"
            f"## Usage Example\n"
            f"<tool_call>\n"
            f"<tool_name>tool_name_here</tool_name>\n"
            f"<arguments>\n"
            f"{{\n"
            f'  "param1": "value1",\n'
            f'  "param2": "value2 \\"escaped string\\""\n'
            f"}}\n"
            f"</arguments>\n"
            f"</tool_call>\n\n"
            f"## Available Tools\n"
            f"Here are the functions available within <tools></tools> XML tags:\n\n"
            f"<tools>\n" + "\n".join(tool_functions) + f"\n</tools>"
        )

    def _get_server_names(self) -> List[str]:
        """Get list of server names from configuration."""
        if isinstance(self.raw_config, str):
            return ["default"]  # Single server gets default name
        elif isinstance(self.raw_config, dict) and "mcpServers" in self.raw_config:
            return list(self.raw_config["mcpServers"].keys())
        else:
            return ["default"]

    def _is_multi_server(self) -> bool:
        """Check if this is a multi-server configuration."""
        return len(self._get_server_names()) > 1

    def _get_server_description(self) -> str:
        """Get a human-readable description of the server configuration."""
        if isinstance(self.raw_config, str):
            return f"HTTP server at {self.raw_config}"
        elif isinstance(self.raw_config, dict) and "mcpServers" in self.raw_config:
            servers = list(self.raw_config["mcpServers"].keys())
            if len(servers) == 1:
                server_config = self.raw_config["mcpServers"][servers[0]]
                transport = server_config.get("transport", "http")
                if transport == "stdio":
                    cmd = server_config.get("command", "<command>")
                    return f"local stdio server '{servers[0]}' via command: {cmd}"
                else:
                    url = server_config.get("url", "unknown")
                    return f"HTTP server '{servers[0]}' at {url}"
            else:
                return f"multi-server configuration with {len(servers)} servers: {', '.join(servers)}"
        else:
            return str(self.raw_config)

    def execute_action(self, action: str) -> Tuple[bool, bool, str, str]:
        """Execute the MCP tool action.

        Args:
            action: Raw action string containing MCP tool call

        Returns:
            tuple: (is_valid, has_error, observation, parsed_action)
        """
        tool_name, parsed_action, parameters, is_valid = self._parse_action(action)

        if not is_valid:
            return False, True, "", ""

        # Check if the requested tool exists
        # Note: We still check cached tools for quick validation
        available_tools = self.get_available_tools()
        tool_names = [tool["name"] for tool in available_tools]

        if tool_name not in tool_names:
            error_msg = f"Tool '{tool_name}' not found. Available tools ({len(tool_names)}): {', '.join(tool_names[:10])}"
            print(f"[MCP] ❌ Tool not found in cache: {tool_name}")
            print(f"[MCP] Cached tools: {len(tool_names)}")
            print(f"[MCP] Re-discovering tools to verify...")
            # Force re-discovery to check if tools changed (thread-safe)
            with self._discovery_lock:
                self._tools_discovered = False
                self._available_tools = None
            available_tools = self.get_available_tools()
            tool_names = [tool["name"] for tool in available_tools]
            if tool_name in tool_names:
                print(f"[MCP] ✓ Tool found after re-discovery: {tool_name}")
            else:
                print(f"[MCP] Still not found. Available: {', '.join(tool_names[:10])}")
                return False, True, error_msg, parsed_action

        try:
            # Print to console which tool is being executed for debugging
            print(f"[MCP] Executing tool: {tool_name}")
            if parameters:
                print(f"[MCP] Parameters: {parameters}")
            
            # Execute the MCP tool (synchronously)
            response = self._execute_mcp_tool(tool_name, parameters)
            ERROR_PREFIXES = ("[Tool execution error", "[Tool execution failed")
            has_error = response.startswith(ERROR_PREFIXES)
            observation = f"\n<tool_response>\n{response}\n</tool_response>\n"
            
            if has_error:
                print(f"[MCP] ❌ Tool {tool_name} returned error: {response[:200]}")
                logger.warning(f"Tool {tool_name} returned error: {response[:200]}")
            else:
                print(f"[MCP] ✅ Tool {tool_name} executed successfully")
            
            return True, has_error, observation, parsed_action

        except Exception as e:
            error_msg = f"MCP tool execution failed for '{tool_name}': {e}"
            print(f"[MCP] ❌ {error_msg}")
            logger.error(error_msg, exc_info=True)  # Include full traceback
            return False, True, error_msg, parsed_action

    def execute_tool(self, tool_name: str, parameters: Dict[str, Any], tool_call_id: str) -> str:
        """Execute the MCP tool.

        Args:
            tool_name: The name of the tool to execute
            parameters: The parameters of the tool to execute

        Returns:
            The result of the tool execution
        """

        # Check if the requested tool exists
        # Note: We still check cached tools for quick validation
        available_tools = self.get_available_tools()
        tool_names = [tool["name"] for tool in available_tools]

        if tool_name not in tool_names:
            error_msg = f"Tool '{tool_name}' not found."
            return False, True, error_msg, tool_name, tool_call_id

        try:
            response = self._execute_mcp_tool(tool_name, parameters)
            ERROR_PREFIXES = ("[Tool execution error", "[Tool execution failed")
            has_error = response.startswith(ERROR_PREFIXES)
            observation = response

            return True, has_error, observation, tool_name, tool_call_id

        except Exception as e:
            error_msg = f"MCP tool execution failed for '{tool_name}': {e}"
            print(f"[MCP] ❌ {error_msg}")
            logger.error(error_msg, exc_info=True)  # Include full traceback
            return False, True, error_msg, tool_name, tool_call_id