"""
Twitch chat integration plugin for elizaOS agents.

This plugin provides Twitch chat integration using the twitchio library.
"""

from elizaos_plugin_twitch.types import (
    TwitchEventTypes,
    TwitchMessage,
    TwitchMessageSendOptions,
    TwitchRole,
    TwitchSendResult,
    TwitchSettings,
    TwitchUserInfo,
    TwitchApiError,
    TwitchConfigurationError,
    TwitchNotConnectedError,
    TwitchPluginError,
    TwitchServiceNotInitializedError,
    format_channel_for_display,
    get_twitch_user_display_name,
    normalize_channel,
    split_message_for_twitch,
    strip_markdown_for_twitch,
    MAX_TWITCH_MESSAGE_LENGTH,
    TWITCH_SERVICE_NAME,
)
from elizaos_plugin_twitch.service import TwitchService
from elizaos_plugin_twitch.actions import (
    send_message_action,
    join_channel_action,
    leave_channel_action,
    list_channels_action,
)
from elizaos_plugin_twitch.providers import (
    channel_state_provider,
    user_context_provider,
)

__all__ = [
    # Service
    "TwitchService",
    # Types
    "TwitchEventTypes",
    "TwitchMessage",
    "TwitchMessageSendOptions",
    "TwitchRole",
    "TwitchSendResult",
    "TwitchSettings",
    "TwitchUserInfo",
    # Errors
    "TwitchApiError",
    "TwitchConfigurationError",
    "TwitchNotConnectedError",
    "TwitchPluginError",
    "TwitchServiceNotInitializedError",
    # Utilities
    "format_channel_for_display",
    "get_twitch_user_display_name",
    "normalize_channel",
    "split_message_for_twitch",
    "strip_markdown_for_twitch",
    # Constants
    "MAX_TWITCH_MESSAGE_LENGTH",
    "TWITCH_SERVICE_NAME",
    # Actions
    "send_message_action",
    "join_channel_action",
    "leave_channel_action",
    "list_channels_action",
    # Providers
    "channel_state_provider",
    "user_context_provider",
]

# Plugin metadata
PLUGIN_NAME = "twitch"
PLUGIN_DESCRIPTION = "Twitch chat integration plugin for elizaOS with real-time messaging"
PLUGIN_VERSION = "2.0.0-alpha"


def get_plugin():
    """Return the plugin definition for elizaOS registration."""
    return {
        "name": PLUGIN_NAME,
        "description": PLUGIN_DESCRIPTION,
        "version": PLUGIN_VERSION,
        "services": [TwitchService],
        "actions": [
            send_message_action,
            join_channel_action,
            leave_channel_action,
            list_channels_action,
        ],
        "providers": [
            channel_state_provider,
            user_context_provider,
        ],
    }
