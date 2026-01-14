"""Tests for N8n providers."""

import pytest

pytest.importorskip("anthropic", reason="anthropic not installed")

from elizaos_plugin_n8n.providers.capabilities import PluginCreationCapabilitiesProvider
from elizaos_plugin_n8n.providers.exists import PluginExistsProvider
from elizaos_plugin_n8n.providers.registry import PluginRegistryProvider
from elizaos_plugin_n8n.providers.status import (
    PluginCreationStatusProvider,
    ProviderContext,
)


class TestPluginCreationStatusProvider:
    """Tests for PluginCreationStatusProvider."""

    @pytest.fixture
    def provider(self) -> PluginCreationStatusProvider:
        """Create provider instance."""
        return PluginCreationStatusProvider()

    @pytest.mark.asyncio
    async def test_name(self, provider: PluginCreationStatusProvider) -> None:
        """Test provider name."""
        assert provider.name == "plugin_creation_status"

    @pytest.mark.asyncio
    async def test_get_no_jobs(self, provider: PluginCreationStatusProvider) -> None:
        """Test get with no jobs."""
        context = ProviderContext(state={})
        result = await provider.get(context)
        assert "No active" in result.text

    @pytest.mark.asyncio
    async def test_get_active_job(self, provider: PluginCreationStatusProvider) -> None:
        """Test get with active job."""
        context = ProviderContext(
            state={
                "jobs": [
                    {
                        "status": "running",
                        "currentPhase": "generating",
                        "progress": 50,
                        "specification": {"name": "@elizaos/plugin-test"},
                    }
                ]
            }
        )
        result = await provider.get(context)
        assert "@elizaos/plugin-test" in result.text
        assert "50" in result.text


class TestPluginCreationCapabilitiesProvider:
    """Tests for PluginCreationCapabilitiesProvider."""

    @pytest.fixture
    def provider(self) -> PluginCreationCapabilitiesProvider:
        """Create provider instance."""
        return PluginCreationCapabilitiesProvider()

    @pytest.mark.asyncio
    async def test_name(self, provider: PluginCreationCapabilitiesProvider) -> None:
        """Test provider name."""
        assert provider.name == "plugin_creation_capabilities"

    @pytest.mark.asyncio
    async def test_get_no_api_key(self, provider: PluginCreationCapabilitiesProvider) -> None:
        """Test get without API key."""
        context = ProviderContext(state={"hasApiKey": False})
        result = await provider.get(context)
        assert "requires ANTHROPIC_API_KEY" in result.text
        assert result.data["aiEnabled"] is False

    @pytest.mark.asyncio
    async def test_get_with_api_key(self, provider: PluginCreationCapabilitiesProvider) -> None:
        """Test get with API key."""
        context = ProviderContext(state={"hasApiKey": True})
        result = await provider.get(context)
        assert "fully operational" in result.text
        assert result.data["aiEnabled"] is True


class TestPluginRegistryProvider:
    """Tests for PluginRegistryProvider."""

    @pytest.fixture
    def provider(self) -> PluginRegistryProvider:
        """Create provider instance."""
        return PluginRegistryProvider()

    @pytest.mark.asyncio
    async def test_name(self, provider: PluginRegistryProvider) -> None:
        """Test provider name."""
        assert provider.name == "plugin_registry"

    @pytest.mark.asyncio
    async def test_get_empty_registry(self, provider: PluginRegistryProvider) -> None:
        """Test get with empty registry."""
        context = ProviderContext(state={})
        result = await provider.get(context)
        assert "No plugins" in result.text
        assert result.data["count"] == 0

    @pytest.mark.asyncio
    async def test_get_with_plugins(self, provider: PluginRegistryProvider) -> None:
        """Test get with plugins."""
        context = ProviderContext(
            state={
                "pluginRegistry": [
                    {"name": "@elizaos/plugin-a"},
                    {"name": "@elizaos/plugin-b"},
                ]
            }
        )
        result = await provider.get(context)
        assert "@elizaos/plugin-a" in result.text
        assert result.data["count"] == 2


class TestPluginExistsProvider:
    """Tests for PluginExistsProvider."""

    @pytest.fixture
    def provider(self) -> PluginExistsProvider:
        """Create provider instance."""
        return PluginExistsProvider()

    @pytest.mark.asyncio
    async def test_name(self, provider: PluginExistsProvider) -> None:
        """Test provider name."""
        assert provider.name == "plugin_exists"

    @pytest.mark.asyncio
    async def test_get_no_plugin_name(self, provider: PluginExistsProvider) -> None:
        """Test get without plugin name."""
        context = ProviderContext(state={})
        result = await provider.get(context)
        assert "No plugin name" in result.text

    @pytest.mark.asyncio
    async def test_get_plugin_exists(self, provider: PluginExistsProvider) -> None:
        """Test get when plugin exists."""
        context = ProviderContext(
            state={
                "checkPluginName": "@elizaos/plugin-test",
                "pluginRegistry": [{"name": "@elizaos/plugin-test"}],
            }
        )
        result = await provider.get(context)
        assert "already exists" in result.text
        assert result.data["exists"] is True

    @pytest.mark.asyncio
    async def test_get_plugin_not_exists(self, provider: PluginExistsProvider) -> None:
        """Test get when plugin doesn't exist."""
        context = ProviderContext(
            state={
                "checkPluginName": "@elizaos/plugin-new",
                "pluginRegistry": [{"name": "@elizaos/plugin-test"}],
            }
        )
        result = await provider.get(context)
        assert "does not exist" in result.text
        assert result.data["exists"] is False
