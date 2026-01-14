"""Tests for KnowledgePlugin."""

import pytest

from elizaos_plugin_knowledge.plugin import (
    KnowledgePlugin,
    create_knowledge_plugin,
    get_knowledge_plugin,
)
from elizaos_plugin_knowledge.types import KnowledgeConfig


class TestKnowledgePlugin:
    """Tests for KnowledgePlugin."""

    def test_init(self) -> None:
        """Test plugin initialization."""
        plugin = KnowledgePlugin()

        assert plugin.name == "knowledge"
        assert plugin.version == "1.6.1"
        assert plugin.service is not None
        assert plugin.knowledge_provider is not None
        assert plugin.documents_provider is not None

    def test_init_with_config(self) -> None:
        """Test plugin initialization with config."""
        config = KnowledgeConfig(
            embedding_provider="google",
            chunk_size=200,
        )
        plugin = KnowledgePlugin(config=config)

        assert plugin._config.embedding_provider == "google"
        assert plugin._config.chunk_size == 200

    @pytest.mark.asyncio
    async def test_init_method(self) -> None:
        """Test async init method."""
        plugin = KnowledgePlugin()
        await plugin.init()

        assert plugin._initialized

    @pytest.mark.asyncio
    async def test_add_knowledge(self) -> None:
        """Test adding knowledge through plugin."""
        plugin = KnowledgePlugin()

        result = await plugin.add_knowledge(
            content="Test knowledge content. " * 20,
            content_type="text/plain",
            filename="test.txt",
        )

        assert result.success
        assert result.document_id is not None

    @pytest.mark.asyncio
    async def test_delete_knowledge(self) -> None:
        """Test deleting knowledge through plugin."""
        plugin = KnowledgePlugin()

        result = await plugin.add_knowledge(
            content="Content to delete. " * 20,
            content_type="text/plain",
            filename="delete.txt",
        )

        deleted = await plugin.delete_knowledge(result.document_id)
        assert deleted

    def test_get_providers(self) -> None:
        """Test getting plugin providers."""
        plugin = KnowledgePlugin()
        providers = plugin.get_providers()

        assert len(providers) >= 2
        assert any(p["name"] == "knowledge" for p in providers)
        assert any(p["name"] == "documents" for p in providers)
        assert any(p["name"] == "KNOWLEDGE" for p in providers)
        assert any(p["name"] == "AVAILABLE_DOCUMENTS" for p in providers)

    def test_get_actions(self) -> None:
        """Test getting plugin actions."""
        plugin = KnowledgePlugin()
        actions = plugin.get_actions()

        assert len(actions) == 3
        action_names = [a["name"] for a in actions]
        assert "add-knowledge" in action_names
        assert "search-knowledge" in action_names
        assert "delete-knowledge" in action_names


class TestPluginFactory:
    """Tests for plugin factory functions."""

    def test_create_knowledge_plugin(self) -> None:
        """Test creating plugin via factory."""
        plugin = create_knowledge_plugin()

        assert plugin is not None
        assert isinstance(plugin, KnowledgePlugin)

    def test_create_knowledge_plugin_with_config(self) -> None:
        """Test creating plugin with config via factory."""
        config = KnowledgeConfig(chunk_size=300)
        plugin = create_knowledge_plugin(config=config)

        assert plugin._config.chunk_size == 300

    def test_get_knowledge_plugin(self) -> None:
        """Test getting plugin via getter."""
        # Create a new plugin
        created = create_knowledge_plugin()
        retrieved = get_knowledge_plugin()

        assert retrieved is created
