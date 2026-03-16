"""Integration tests for the MCP client."""

from __future__ import annotations

import pytest

from elizaos_plugin_mcp import McpClient
from elizaos_plugin_mcp.types import ConnectionStatus, McpError


class TestMcpClientIntegration:
    """Integration tests that require a real MCP server."""

    @pytest.mark.asyncio
    async def test_list_tools(self, memory_server_client: McpClient) -> None:
        """Test listing tools from the memory server."""
        tools = await memory_server_client.list_tools()

        assert isinstance(tools, list)
        assert len(tools) > 0

        # Memory server should have create_entities tool (knowledge graph based)
        tool_names = [t.name for t in tools]
        assert "create_entities" in tool_names or "read_graph" in tool_names

    @pytest.mark.asyncio
    async def test_call_tool(self, memory_server_client: McpClient) -> None:
        """Test calling a tool on the memory server."""
        tools = await memory_server_client.list_tools()

        if not tools:
            pytest.skip("No tools available")

        # Use read_graph which doesn't require any arguments
        read_tool = next((t for t in tools if t.name == "read_graph"), None)
        if read_tool is None:
            pytest.skip("read_graph tool not found")

        result = await memory_server_client.call_tool(
            name="read_graph",
            arguments={},
        )

        assert result is not None
        assert result.content is not None

    @pytest.mark.asyncio
    async def test_connection_status(self, memory_server_client: McpClient) -> None:
        """Test that the client reports connected status."""
        assert memory_server_client.status == ConnectionStatus.CONNECTED

    @pytest.mark.asyncio
    async def test_server_info(self, memory_server_client: McpClient) -> None:
        """Test that server info is populated."""
        assert memory_server_client.server_info is not None


class TestMcpClientErrors:
    """Tests for error handling in MCP client."""

    @pytest.mark.asyncio
    async def test_call_tool_not_connected(self) -> None:
        """Test that calling a tool when not connected raises an error."""
        from elizaos_plugin_mcp.transports.stdio import StdioTransport
        from elizaos_plugin_mcp.types import StdioServerConfig

        config = StdioServerConfig(command="false")  # Command that fails immediately
        transport = StdioTransport(config)
        client = McpClient(transport)

        # Don't connect - just try to call a tool
        with pytest.raises(McpError) as exc_info:
            await client.call_tool("some_tool")

        assert exc_info.value.code == "NOT_CONNECTED"

    @pytest.mark.asyncio
    async def test_call_tool_empty_name(self, memory_server_client: McpClient) -> None:
        """Test that calling a tool with empty name raises an error."""
        with pytest.raises(McpError) as exc_info:
            await memory_server_client.call_tool("")

        assert exc_info.value.code == "INVALID_ARGUMENT"

    @pytest.mark.asyncio
    async def test_read_resource_empty_uri(self, memory_server_client: McpClient) -> None:
        """Test that reading a resource with empty URI raises an error."""
        with pytest.raises(McpError) as exc_info:
            await memory_server_client.read_resource("")

        assert exc_info.value.code == "INVALID_ARGUMENT"
