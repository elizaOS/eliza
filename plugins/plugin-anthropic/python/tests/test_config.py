"""Unit tests for elizaOS Plugin Anthropic configuration.

These tests do not require an API key.
"""

from __future__ import annotations

import os

import pytest

from elizaos_plugin_anthropic.config import AnthropicConfig
from elizaos_plugin_anthropic.errors import ApiKeyError


class TestAnthropicConfig:
    """Tests for AnthropicConfig class."""

    def test_config_creation(self) -> None:
        config = AnthropicConfig("test-api-key")
        assert config.api_key == "test-api-key"
        assert config.base_url == "https://api.anthropic.com"

    def test_config_empty_key_fails(self) -> None:
        with pytest.raises(ApiKeyError):
            AnthropicConfig("")

    def test_config_whitespace_key_fails(self) -> None:
        with pytest.raises(ApiKeyError):
            AnthropicConfig("   ")

    def test_config_builder_pattern(self) -> None:
        config = (
            AnthropicConfig("test-key").with_base_url("https://custom.api.com").with_timeout(120)
        )
        assert config.base_url == "https://custom.api.com"
        assert config.timeout_seconds == 120

    def test_config_with_models(self) -> None:
        from elizaos_plugin_anthropic import Model

        config = (
            AnthropicConfig("test-key")
            .with_small_model(Model(Model.CLAUDE_3_HAIKU))
            .with_large_model(Model(Model.CLAUDE_3_OPUS))
        )
        assert config.small_model.id == Model.CLAUDE_3_HAIKU
        assert config.large_model.id == Model.CLAUDE_3_OPUS

    def test_config_default_timeout(self) -> None:
        config = AnthropicConfig("test-key")
        assert config.timeout_seconds == 60

    def test_config_messages_url(self) -> None:
        config = AnthropicConfig("test-key")
        assert config.messages_url == "https://api.anthropic.com/v1/messages"

        custom_config = AnthropicConfig("test-key").with_base_url("https://custom.api.com")
        assert custom_config.messages_url == "https://custom.api.com/v1/messages"


class TestAnthropicConfigFromEnv:
    """Tests for AnthropicConfig.from_env()."""

    def test_from_env_missing_key(self) -> None:
        # Ensure the env var is not set
        os.environ.pop("ANTHROPIC_API_KEY", None)

        with pytest.raises(ApiKeyError):
            AnthropicConfig.from_env()

    def test_from_env_with_key(self) -> None:
        os.environ["ANTHROPIC_API_KEY"] = "test-env-key"

        try:
            config = AnthropicConfig.from_env()
            assert config.api_key == "test-env-key"
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)

    def test_from_env_with_custom_base_url(self) -> None:
        os.environ["ANTHROPIC_API_KEY"] = "test-key"
        os.environ["ANTHROPIC_BASE_URL"] = "https://custom.api.com"

        try:
            config = AnthropicConfig.from_env()
            assert config.base_url == "https://custom.api.com"
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)
            os.environ.pop("ANTHROPIC_BASE_URL", None)

    def test_from_env_with_custom_timeout(self) -> None:
        os.environ["ANTHROPIC_API_KEY"] = "test-key"
        os.environ["ANTHROPIC_TIMEOUT_SECONDS"] = "120"

        try:
            config = AnthropicConfig.from_env()
            assert config.timeout_seconds == 120
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)
            os.environ.pop("ANTHROPIC_TIMEOUT_SECONDS", None)

    def test_from_env_ignores_empty_base_url(self) -> None:
        os.environ["ANTHROPIC_API_KEY"] = "test-key"
        os.environ["ANTHROPIC_BASE_URL"] = ""

        try:
            config = AnthropicConfig.from_env()
            assert config.base_url == "https://api.anthropic.com"
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)
            os.environ.pop("ANTHROPIC_BASE_URL", None)
