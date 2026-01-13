"""Tests for the N8nConfig."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

pytest.importorskip("anthropic", reason="anthropic not installed")

from elizaos_plugin_n8n import N8nConfig
from elizaos_plugin_n8n.errors import ApiKeyError
from elizaos_plugin_n8n.models import ClaudeModel


class TestN8nConfig:
    """Tests for N8nConfig."""

    def test_config_creation(self, mock_api_key: str) -> None:
        """Test config creation with API key."""
        config = N8nConfig(api_key=mock_api_key)
        assert config.api_key == mock_api_key
        assert config.model == ClaudeModel.OPUS_3

    def test_config_default_model(self, mock_api_key: str) -> None:
        """Test config has default model."""
        config = N8nConfig(api_key=mock_api_key)
        assert config.model == ClaudeModel.default()

    def test_config_custom_model(self, mock_api_key: str) -> None:
        """Test config with custom model."""
        config = N8nConfig(api_key=mock_api_key, model=ClaudeModel.SONNET_3_5)
        assert config.model == ClaudeModel.SONNET_3_5

    def test_config_from_env(self, env_with_api_key: None, mock_api_key: str) -> None:
        """Test config creation from environment."""
        config = N8nConfig.from_env()
        assert config.api_key == mock_api_key

    def test_config_from_env_missing_key(self) -> None:
        """Test config from env raises error when key missing."""
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with pytest.raises(ApiKeyError):
            N8nConfig.from_env()

    def test_get_plugins_dir(self, mock_api_key: str, tmp_path: Path) -> None:
        """Test getting plugins directory."""
        config = N8nConfig(api_key=mock_api_key, data_dir=tmp_path)
        plugins_dir = config.get_plugins_dir()
        assert plugins_dir.exists()
        assert plugins_dir == tmp_path / "plugins"

    def test_validate_success(self, mock_api_key: str) -> None:
        """Test validation succeeds with valid config."""
        config = N8nConfig(api_key=mock_api_key)
        config.validate()  # Should not raise

    def test_validate_missing_key(self) -> None:
        """Test validation fails without API key."""
        config = N8nConfig(api_key="")
        with pytest.raises(ApiKeyError):
            config.validate()


class TestClaudeModel:
    """Tests for ClaudeModel enum."""

    def test_default_model(self) -> None:
        """Test default model is Opus."""
        assert ClaudeModel.default() == ClaudeModel.OPUS_3

    def test_model_values(self) -> None:
        """Test model values."""
        assert ClaudeModel.SONNET_3_5.value == "claude-3-5-sonnet-20241022"
        assert ClaudeModel.OPUS_3.value == "claude-3-opus-20240229"

    def test_display_name(self) -> None:
        """Test display names."""
        assert ClaudeModel.SONNET_3_5.display_name == "Claude 3.5 Sonnet"
        assert ClaudeModel.OPUS_3.display_name == "Claude 3 Opus"
