"""Tests for Telegram configuration."""

import os
from unittest.mock import patch

import pytest

from elizaos_plugin_telegram.config import TelegramConfig


class TestTelegramConfig:
    """Tests for TelegramConfig."""

    def test_config_creation(self) -> None:
        """Test creating config with all fields."""
        config = TelegramConfig(
            bot_token="test-token",
            api_root="https://custom.api.telegram.org",
            allowed_chats=["123", "456"],
        )

        assert config.bot_token == "test-token"
        assert config.api_root == "https://custom.api.telegram.org"
        assert config.allowed_chats == ["123", "456"]

    def test_config_defaults(self) -> None:
        """Test default values."""
        config = TelegramConfig(bot_token="test-token")

        assert config.api_root == "https://api.telegram.org"
        assert config.allowed_chats == []

    def test_from_env(self) -> None:
        """Test creating config from environment."""
        env = {
            "TELEGRAM_BOT_TOKEN": "env-token",
            "TELEGRAM_API_ROOT": "https://env.api.telegram.org",
            "TELEGRAM_ALLOWED_CHATS": '["111", "222"]',
        }

        with patch.dict(os.environ, env, clear=False):
            config = TelegramConfig.from_env()

        assert config.bot_token == "env-token"
        assert config.api_root == "https://env.api.telegram.org"
        assert config.allowed_chats == ["111", "222"]

    def test_from_env_missing_token(self) -> None:
        """Test error when token is missing."""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="TELEGRAM_BOT_TOKEN"):
                TelegramConfig.from_env()

    def test_from_env_invalid_allowed_chats(self) -> None:
        """Test handling of invalid allowed_chats JSON."""
        env = {
            "TELEGRAM_BOT_TOKEN": "test-token",
            "TELEGRAM_ALLOWED_CHATS": "invalid-json",
        }

        with patch.dict(os.environ, env, clear=False):
            config = TelegramConfig.from_env()

        assert config.allowed_chats == []

    def test_is_chat_allowed_no_restrictions(self) -> None:
        """Test chat authorization with no restrictions."""
        config = TelegramConfig(bot_token="test-token")

        assert config.is_chat_allowed("123")
        assert config.is_chat_allowed("456")

    def test_is_chat_allowed_with_restrictions(self) -> None:
        """Test chat authorization with restrictions."""
        config = TelegramConfig(
            bot_token="test-token",
            allowed_chats=["123", "456"],
        )

        assert config.is_chat_allowed("123")
        assert config.is_chat_allowed("456")
        assert not config.is_chat_allowed("789")
