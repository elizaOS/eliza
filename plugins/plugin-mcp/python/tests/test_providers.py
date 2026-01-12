"""Tests for MCP providers."""

import pytest

from elizaos_plugin_mcp.providers.mcp import (
    McpProvider,
    ProviderContext,
)


class TestMcpProvider:
    """Tests for McpProvider."""

    @pytest.fixture
    def provider(self) -> McpProvider:
        """Create provider instance."""
        return McpProvider()

    @pytest.mark.asyncio
    async def test_name(self, provider: McpProvider) -> None:
        """Test provider name."""
        assert provider.name == "MCP"

    @pytest.mark.asyncio
    async def test_format_servers_empty(self, provider: McpProvider) -> None:
        """Test formatting empty servers list."""
        result = provider.format_servers([])
        assert "No MCP servers" in result

    @pytest.mark.asyncio
    async def test_format_servers_with_data(self, provider: McpProvider) -> None:
        """Test formatting servers with data."""
        servers = [
            {
                "name": "test-server",
                "status": "connected",
                "tools": [{"name": "search", "description": "Search the web"}],
                "resources": [{"uri": "file:///docs", "name": "Documentation"}],
            }
        ]
        result = provider.format_servers(servers)

        assert "test-server" in result
        assert "connected" in result
        assert "search" in result
        assert "Documentation" in result

    @pytest.mark.asyncio
    async def test_get_empty_state(self, provider: McpProvider) -> None:
        """Test get with empty state."""
        context = ProviderContext(state={})
        result = await provider.get(context)

        assert "No MCP servers" in result.text
        assert result.data["mcpServerCount"] == 0

    @pytest.mark.asyncio
    async def test_get_with_servers(self, provider: McpProvider) -> None:
        """Test get with servers in state."""
        context = ProviderContext(
            state={
                "mcpServers": [
                    {"name": "server1", "status": "connected"},
                    {"name": "server2", "status": "disconnected"},
                ]
            }
        )
        result = await provider.get(context)

        assert "server1" in result.text
        assert result.data["mcpServerCount"] == 2
