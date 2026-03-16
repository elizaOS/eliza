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
    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self._request_id = 0
        self._status = ConnectionStatus.DISCONNECTED
        self._server_info: dict[str, Any] = {}

    @property
    def status(self) -> ConnectionStatus:
        return self._status

    @property
    def server_info(self) -> dict[str, Any]:
        return self._server_info

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def connect(self) -> None:
        self._status = ConnectionStatus.CONNECTING

        await self._transport.connect()
        init_request = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "elizaos-plugin-mcp",
                    "version": "2.0.0-alpha",
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

        initialized_notification = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        }
        await self._transport.send(initialized_notification)

        self._status = ConnectionStatus.CONNECTED

    async def close(self) -> None:
        await self._transport.close()
        self._status = ConnectionStatus.DISCONNECTED

    async def list_tools(self) -> list[McpTool]:
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

        return [McpTool.model_validate(tool) for tool in tools_data]  # type: ignore[attr-defined]

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> McpToolResult:
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
        return McpToolResult.model_validate(result)  # type: ignore[attr-defined,no-any-return]

    async def list_resources(self) -> list[McpResource]:
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

        return [McpResource.model_validate(resource) for resource in resources_data]  # type: ignore[attr-defined]

    async def read_resource(self, uri: str) -> list[McpResourceContent]:
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

        return [McpResourceContent.model_validate(content) for content in contents_data]  # type: ignore[attr-defined]

    async def list_resource_templates(self) -> list[McpResourceTemplate]:
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

        return [McpResourceTemplate.model_validate(template) for template in templates_data]  # type: ignore[attr-defined]

    async def __aenter__(self) -> McpClient:
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()
