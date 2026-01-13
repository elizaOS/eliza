"""Tests for the PluginCreationClient."""

from __future__ import annotations

import pytest

pytest.importorskip("anthropic", reason="anthropic not installed")

from elizaos_plugin_n8n import (
    N8nConfig,
    PluginCreationClient,
    PluginSpecification,
)


class TestPluginCreationClient:
    """Tests for PluginCreationClient."""

    def test_client_creation(self, config: N8nConfig) -> None:
        """Test client creation."""
        client = PluginCreationClient(config)
        assert client is not None
        assert client.config == config

    def test_get_created_plugins_empty(self, client: PluginCreationClient) -> None:
        """Test getting created plugins when empty."""
        plugins = client.get_created_plugins()
        assert plugins == []

    def test_is_plugin_created_false(self, client: PluginCreationClient) -> None:
        """Test checking if plugin exists when it doesn't."""
        assert client.is_plugin_created("@test/non-existent") is False

    def test_get_all_jobs_empty(self, client: PluginCreationClient) -> None:
        """Test getting all jobs when empty."""
        jobs = client.get_all_jobs()
        assert jobs == []

    def test_get_job_status_not_found(self, client: PluginCreationClient) -> None:
        """Test getting job status for non-existent job."""
        job = client.get_job_status("non-existent-id")
        assert job is None

    def test_cancel_job_not_found(self, client: PluginCreationClient) -> None:
        """Test cancelling non-existent job."""
        result = client.cancel_job("non-existent-id")
        assert result is False

    def test_cleanup_old_jobs_empty(self, client: PluginCreationClient) -> None:
        """Test cleanup when no jobs exist."""
        count = client.cleanup_old_jobs()
        assert count == 0


class TestPluginNameValidation:
    """Tests for plugin name validation."""

    def test_valid_plugin_name_with_scope(self, client: PluginCreationClient) -> None:
        """Test valid plugin name with scope."""
        assert client._is_valid_plugin_name("@elizaos/plugin-test") is True

    def test_valid_plugin_name_without_scope(self, client: PluginCreationClient) -> None:
        """Test valid plugin name without scope."""
        assert client._is_valid_plugin_name("scope/plugin-test") is True

    def test_invalid_plugin_name_no_slash(self, client: PluginCreationClient) -> None:
        """Test invalid plugin name without slash."""
        assert client._is_valid_plugin_name("invalid-name") is False

    def test_invalid_plugin_name_path_traversal(self, client: PluginCreationClient) -> None:
        """Test invalid plugin name with path traversal."""
        assert client._is_valid_plugin_name("@scope/../evil") is False

    def test_sanitize_plugin_name(self, client: PluginCreationClient) -> None:
        """Test plugin name sanitization."""
        result = client._sanitize_plugin_name("@elizaos/plugin-test")
        assert result == "elizaos-plugin-test"


class TestPluginSpecification:
    """Tests for PluginSpecification."""

    def test_create_from_dict(self, valid_plugin_spec: dict) -> None:
        """Test creating specification from dict."""
        spec = PluginSpecification(**valid_plugin_spec)
        assert spec.name == "@test/plugin-example"
        assert spec.description == "A test plugin for testing purposes"
        assert spec.version == "2.0.0"

    def test_default_version(self) -> None:
        """Test default version."""
        spec = PluginSpecification(
            name="@test/plugin",
            description="Test plugin",
        )
        assert spec.version == "1.0.0"

    def test_optional_fields(self) -> None:
        """Test optional fields are None by default."""
        spec = PluginSpecification(
            name="@test/plugin",
            description="Test plugin",
        )
        assert spec.actions is None
        assert spec.providers is None
        assert spec.services is None
        assert spec.evaluators is None
