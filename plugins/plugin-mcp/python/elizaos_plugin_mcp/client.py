"""MCP Client implementation."""

from __future__ import annotations

from types import TracebackType
from typing import Any

from elizaos_plugin_mcp.transports.base import Transport
from elizaos_plugin_mcp.types import (
    ConnectionStatus,
    McpError,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpTool,
    McpToolResult,
)


class McpClient:
    """Client for communicating with MCP servers."""

    def __init__(self, transport: Transport) -> None:
        """Initialize the MCP client.

        Args:
            transport: The transport to use for communication.
        """
        self._transport = transport
        self._request_id = 0
        self._status = ConnectionStatus.DISCONNECTED
        self._server_info: dict[str, Any] = {}

    @property
    def status(self) -> ConnectionStatus:
        """Get the current connection status."""
        return self._status

    @property
    def server_info(self) -> dict[str, Any]:
        """Get the server info received during initialization."""
        return self._server_info

    def _next_id(self) -> int:
        """Generate the next request ID."""
        self._request_id += 1
        return self._request_id

    async def connect(self) -> None:
        """Connect to the MCP server and perform initialization.

        Raises:
            McpError: If connection or initialization fails.
        """
        self._status = ConnectionStatus.CONNECTING

        # Connect the transport
        await self._transport.connect()

        # Send initialize request
        init_request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "elizaos-plugin-mcp",
                    "version": "1.7.0",
                },
            },
        }

        await self._transport.send(init_request)
        response = await self._transport.receive()

        if "error" in response:
            self._status = ConnectionStatus.FAILED
            error = response["error"]
            raise McpError(
                f"Initialization failed: {error.get('message', 'Unknown error')}",
                error.get("code", "INIT_ERROR"),
            )

        self._server_info = response.get("result", {})

        # Send initialized notification
        initialized_notification = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        }
        await self._transport.send(initialized_notification)

        self._status = ConnectionStatus.CONNECTED

    async def close(self) -> None:
        """Close the connection to the MCP server."""
        await self._transport.close()
        self._status = ConnectionStatus.DISCONNECTED

    async def list_tools(self) -> list[McpTool]:
        """List all available tools from the server.

        Returns:
            List of available tools.

        Raises:
            McpError: If the request fails.
        """
        if self._status != ConnectionStatus.CONNECTED:
            raise McpError("Client not connected", "NOT_CONNECTED")

        request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/list",
        }

        await self._transport.send(request)
        response = await self._transport.receive()

        if "error" in response:
            error = response["error"]
            raise McpError(
                f"Failed to list tools: {error.get('message', 'Unknown error')}",
                error.get("code", "LIST_TOOLS_ERROR"),
            )

        result = response.get("result", {})
        tools_data = result.get("tools", [])

        return [McpTool.model_validate(tool) for tool in tools_data]

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> McpToolResult:
        """Call a tool on the MCP server.

        Args:
            name: The name of the tool to call.
            arguments: Arguments to pass to the tool.

        Returns:
            The result of the tool call.

        Raises:
            McpError: If the tool call fails.
        """
        if self._status != ConnectionStatus.CONNECTED:
            raise McpError("Client not connected", "NOT_CONNECTED")

        if not name:
            raise McpError("Tool name is required", "INVALID_ARGUMENT")

        request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments or {},
            },
        }

        await self._transport.send(request)
        response = await self._transport.receive()

        if "error" in response:
            error = response["error"]
            raise McpError(
                f"Tool call failed: {error.get('message', 'Unknown error')}",
                error.get("code", "TOOL_CALL_ERROR"),
            )

        result = response.get("result", {})
        return McpToolResult.model_validate(result)

    async def list_resources(self) -> list[McpResource]:
        """List all available resources from the server.

        Returns:
            List of available resources.

        Raises:
            McpError: If the request fails.
        """
        if self._status != ConnectionStatus.CONNECTED:
            raise McpError("Client not connected", "NOT_CONNECTED")

        request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "resources/list",
        }

        await self._transport.send(request)
        response = await self._transport.receive()

        if "error" in response:
            error = response["error"]
            raise McpError(
                f"Failed to list resources: {error.get('message', 'Unknown error')}",
                error.get("code", "LIST_RESOURCES_ERROR"),
            )

        result = response.get("result", {})
        resources_data = result.get("resources", [])

        return [McpResource.model_validate(resource) for resource in resources_data]

    async def read_resource(self, uri: str) -> list[McpResourceContent]:
        """Read a resource from the MCP server.

        Args:
            uri: The URI of the resource to read.

        Returns:
            The content of the resource.

        Raises:
            McpError: If reading the resource fails.
        """
        if self._status != ConnectionStatus.CONNECTED:
            raise McpError("Client not connected", "NOT_CONNECTED")

        if not uri:
            raise McpError("Resource URI is required", "INVALID_ARGUMENT")

        request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "resources/read",
            "params": {
                "uri": uri,
            },
        }

        await self._transport.send(request)
        response = await self._transport.receive()

        if "error" in response:
            error = response["error"]
            raise McpError(
                f"Failed to read resource: {error.get('message', 'Unknown error')}",
                error.get("code", "READ_RESOURCE_ERROR"),
            )

        result = response.get("result", {})
        contents_data = result.get("contents", [])

        return [McpResourceContent.model_validate(content) for content in contents_data]

    async def list_resource_templates(self) -> list[McpResourceTemplate]:
        """List all available resource templates from the server.

        Returns:
            List of available resource templates.

        Raises:
            McpError: If the request fails.
        """
        if self._status != ConnectionStatus.CONNECTED:
            raise McpError("Client not connected", "NOT_CONNECTED")

        request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "resources/templates/list",
        }

        await self._transport.send(request)
        response = await self._transport.receive()

        if "error" in response:
            error = response["error"]
            raise McpError(
                f"Failed to list resource templates: {error.get('message', 'Unknown error')}",
                error.get("code", "LIST_TEMPLATES_ERROR"),
            )

        result = response.get("result", {})
        templates_data = result.get("resourceTemplates", [])

        return [McpResourceTemplate.model_validate(template) for template in templates_data]

    async def __aenter__(self) -> McpClient:
        """Async context manager entry."""
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Async context manager exit."""
        await self.close()
