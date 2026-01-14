"""
Discord plugin configuration.

Configuration can be loaded from environment variables or constructed programmatically.
"""

import os

from pydantic import BaseModel, ConfigDict, field_validator

from elizaos_plugin_discord.error import (
    ConfigError,
    InvalidSnowflakeError,
    MissingSettingError,
)
from elizaos_plugin_discord.types import Snowflake


class DiscordConfig(BaseModel):
    """
    Discord plugin configuration.

    Contains all settings required to connect to and operate a Discord bot.
    """

    model_config = ConfigDict(frozen=True)

    # Required fields
    token: str
    application_id: str

    # Optional fields with defaults
    channel_ids: list[str] = []
    test_channel_id: str | None = None
    voice_channel_id: str | None = None
    should_ignore_bot_messages: bool = True
    should_ignore_direct_messages: bool = False
    should_respond_only_to_mentions: bool = False
    listen_only_channel_ids: list[str] = []

    @field_validator("token")
    @classmethod
    def validate_token(cls, v: str) -> str:
        if not v or not v.strip():
            raise ConfigError("Token cannot be empty")
        return v

    @field_validator("application_id")
    @classmethod
    def validate_application_id(cls, v: str) -> str:
        if not v or not v.strip():
            raise ConfigError("Application ID cannot be empty")
        return v

    @field_validator("channel_ids", "listen_only_channel_ids")
    @classmethod
    def validate_channel_ids(cls, v: list[str]) -> list[str]:
        for channel_id in v:
            try:
                Snowflake(channel_id)
            except InvalidSnowflakeError as e:
                raise ConfigError(f"Invalid channel ID '{channel_id}': {e.message}") from e
        return v

    @field_validator("test_channel_id", "voice_channel_id")
    @classmethod
    def validate_optional_channel_id(cls, v: str | None) -> str | None:
        if v is not None:
            try:
                Snowflake(v)
            except InvalidSnowflakeError as e:
                raise ConfigError(f"Invalid channel ID '{v}': {e.message}") from e
        return v

    @classmethod
    def from_env(cls) -> "DiscordConfig":
        """
        Load configuration from environment variables.

        Required Variables:
            - DISCORD_API_TOKEN: Bot token
            - DISCORD_APPLICATION_ID: Application ID

        Optional Variables:
            - CHANNEL_IDS: Comma-separated list of channel IDs
            - DISCORD_TEST_CHANNEL_ID: Test channel ID
            - DISCORD_VOICE_CHANNEL_ID: Voice channel ID
            - DISCORD_SHOULD_IGNORE_BOT_MESSAGES: "true" or "false"
            - DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "true" or "false"
            - DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "true" or "false"
            - DISCORD_LISTEN_CHANNEL_IDS: Comma-separated list of listen-only channel IDs

        Raises:
            MissingSettingError: If required variables are missing.
            ConfigError: If configuration is invalid.
        """
        token = os.environ.get("DISCORD_API_TOKEN")
        if not token:
            raise MissingSettingError("DISCORD_API_TOKEN")

        application_id = os.environ.get("DISCORD_APPLICATION_ID")
        if not application_id:
            raise MissingSettingError("DISCORD_APPLICATION_ID")

        def parse_bool(value: str | None, default: bool) -> bool:
            if value is None:
                return default
            return value.lower() == "true"

        def parse_list(value: str | None) -> list[str]:
            if not value:
                return []
            return [s.strip() for s in value.split(",") if s.strip()]

        return cls(
            token=token,
            application_id=application_id,
            channel_ids=parse_list(os.environ.get("CHANNEL_IDS")),
            test_channel_id=os.environ.get("DISCORD_TEST_CHANNEL_ID"),
            voice_channel_id=os.environ.get("DISCORD_VOICE_CHANNEL_ID"),
            should_ignore_bot_messages=parse_bool(
                os.environ.get("DISCORD_SHOULD_IGNORE_BOT_MESSAGES"), True
            ),
            should_ignore_direct_messages=parse_bool(
                os.environ.get("DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES"), False
            ),
            should_respond_only_to_mentions=parse_bool(
                os.environ.get("DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS"), False
            ),
            listen_only_channel_ids=parse_list(os.environ.get("DISCORD_LISTEN_CHANNEL_IDS")),
        )

    def validate_all(self) -> None:
        """
        Validate all configuration values.

        Raises:
            ConfigError: If configuration is invalid.
        """
        # Token and application_id are validated by field_validator
        # Channel IDs are validated by field_validator
        # This method exists for explicit validation after construction
        pass
