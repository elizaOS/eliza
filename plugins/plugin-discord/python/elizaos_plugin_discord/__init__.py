"""
elizaOS Discord Plugin

Discord integration for elizaOS agents.
"""

from elizaos_plugin_discord.config import DiscordConfig
from elizaos_plugin_discord.error import (
    DiscordError,
    ClientNotInitializedError,
    ConfigError,
    InvalidSnowflakeError,
    MissingSettingError,
    ValidationError,
)
from elizaos_plugin_discord.types import (
    Snowflake,
    DiscordEventType,
    DiscordMessagePayload,
    DiscordReactionPayload,
    DiscordVoiceStatePayload,
    DiscordChannelType,
    DiscordSettings,
)
from elizaos_plugin_discord.service import DiscordService

__all__ = [
    # Config
    "DiscordConfig",
    # Errors
    "DiscordError",
    "ClientNotInitializedError",
    "ConfigError",
    "InvalidSnowflakeError",
    "MissingSettingError",
    "ValidationError",
    # Types
    "Snowflake",
    "DiscordEventType",
    "DiscordMessagePayload",
    "DiscordReactionPayload",
    "DiscordVoiceStatePayload",
    "DiscordChannelType",
    "DiscordSettings",
    # Service
    "DiscordService",
]

__version__ = "0.1.0"
PLUGIN_NAME = "discord"
PLUGIN_DESCRIPTION = "Discord integration for elizaOS agents"


