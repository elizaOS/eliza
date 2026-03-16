"""Tests for configuration."""

import os

import pytest

from elizaos_plugin_discord.config import DiscordConfig
from elizaos_plugin_discord.error import ConfigError, MissingSettingError


class TestDiscordConfig:
    """Tests for DiscordConfig."""

    def test_create_config(self) -> None:
        """Test creating a configuration."""
        config = DiscordConfig(
            token="test_token",
            application_id="123456789012345678",
        )
        assert config.token == "test_token"
        assert config.application_id == "123456789012345678"
        assert config.should_ignore_bot_messages is True
        assert config.should_ignore_direct_messages is False

    def test_config_with_channel_ids(self) -> None:
        """Test configuration with channel IDs."""
        config = DiscordConfig(
            token="test_token",
            application_id="123456789012345678",
            channel_ids=["111111111111111111", "222222222222222222"],
        )
        assert len(config.channel_ids) == 2

    def test_config_empty_token_fails(self) -> None:
        """Test that empty token fails validation."""
        with pytest.raises(ConfigError):
            DiscordConfig(
                token="",
                application_id="123456789012345678",
            )

    def test_config_empty_app_id_fails(self) -> None:
        """Test that empty application ID fails validation."""
        with pytest.raises(ConfigError):
            DiscordConfig(
                token="test_token",
                application_id="",
            )

    def test_config_invalid_channel_id_fails(self) -> None:
        """Test that invalid channel ID fails validation."""
        with pytest.raises(ConfigError):
            DiscordConfig(
                token="test_token",
                application_id="123456789012345678",
                channel_ids=["invalid"],
            )


class TestConfigFromEnv:
    """Tests for loading config from environment."""

    def setup_method(self) -> None:
        """Clear relevant env vars before each test."""
        for key in [
            "DISCORD_API_TOKEN",
            "DISCORD_APPLICATION_ID",
            "CHANNEL_IDS",
            "DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
        ]:
            os.environ.pop(key, None)

    def teardown_method(self) -> None:
        """Clear relevant env vars after each test."""
        self.setup_method()

    def test_from_env_success(self) -> None:
        """Test loading config from environment."""
        os.environ["DISCORD_API_TOKEN"] = "test_token_from_env"
        os.environ["DISCORD_APPLICATION_ID"] = "123456789012345678"

        config = DiscordConfig.from_env()

        assert config.token == "test_token_from_env"
        assert config.application_id == "123456789012345678"

    def test_from_env_missing_token(self) -> None:
        """Test that missing token raises error."""
        os.environ["DISCORD_APPLICATION_ID"] = "123456789012345678"

        with pytest.raises(MissingSettingError) as exc_info:
            DiscordConfig.from_env()

        assert exc_info.value.setting_name == "DISCORD_API_TOKEN"

    def test_from_env_missing_app_id(self) -> None:
        """Test that missing application ID raises error."""
        os.environ["DISCORD_API_TOKEN"] = "test_token"

        with pytest.raises(MissingSettingError) as exc_info:
            DiscordConfig.from_env()

        assert exc_info.value.setting_name == "DISCORD_APPLICATION_ID"

    def test_from_env_with_channel_ids(self) -> None:
        """Test loading channel IDs from environment."""
        os.environ["DISCORD_API_TOKEN"] = "test_token"
        os.environ["DISCORD_APPLICATION_ID"] = "123456789012345678"
        os.environ["CHANNEL_IDS"] = "111111111111111111, 222222222222222222"

        config = DiscordConfig.from_env()

        assert len(config.channel_ids) == 2
        assert "111111111111111111" in config.channel_ids
        assert "222222222222222222" in config.channel_ids

    def test_from_env_boolean_parsing(self) -> None:
        """Test parsing boolean environment variables."""
        os.environ["DISCORD_API_TOKEN"] = "test_token"
        os.environ["DISCORD_APPLICATION_ID"] = "123456789012345678"
        os.environ["DISCORD_SHOULD_IGNORE_BOT_MESSAGES"] = "false"

        config = DiscordConfig.from_env()

        assert config.should_ignore_bot_messages is False
