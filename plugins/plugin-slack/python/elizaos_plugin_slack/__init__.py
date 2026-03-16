"""
elizaOS Slack Plugin

Slack integration plugin for elizaOS agents with Socket Mode support.
"""

from .service import SlackService, SLACK_SERVICE_NAME
from .types import (
    SlackEventTypes,
    SlackChannel,
    SlackUser,
    SlackMessage,
    SlackFile,
    SlackReaction,
    SlackSettings,
    SlackPluginError,
    SlackServiceNotInitializedError,
    SlackClientNotAvailableError,
    SlackConfigurationError,
    SlackApiError,
    is_valid_channel_id,
    is_valid_user_id,
    is_valid_team_id,
    is_valid_message_ts,
    get_slack_user_display_name,
    get_slack_channel_type,
    MAX_SLACK_MESSAGE_LENGTH,
    MAX_SLACK_BLOCKS,
    MAX_SLACK_FILE_SIZE,
)
from .actions import (
    send_message,
    react_to_message,
    read_channel,
    edit_message,
    delete_message,
    pin_message,
    unpin_message,
    list_channels,
    get_user_info,
    list_pins,
    emoji_list,
)
from .providers import (
    channel_state_provider,
    workspace_info_provider,
    member_list_provider,
)

__version__ = "2.0.0a1"
__all__ = [
    # Service
    "SlackService",
    "SLACK_SERVICE_NAME",
    # Types
    "SlackEventTypes",
    "SlackChannel",
    "SlackUser",
    "SlackMessage",
    "SlackFile",
    "SlackReaction",
    "SlackSettings",
    "SlackPluginError",
    "SlackServiceNotInitializedError",
    "SlackClientNotAvailableError",
    "SlackConfigurationError",
    "SlackApiError",
    # Utilities
    "is_valid_channel_id",
    "is_valid_user_id",
    "is_valid_team_id",
    "is_valid_message_ts",
    "get_slack_user_display_name",
    "get_slack_channel_type",
    # Constants
    "MAX_SLACK_MESSAGE_LENGTH",
    "MAX_SLACK_BLOCKS",
    "MAX_SLACK_FILE_SIZE",
    # Actions
    "send_message",
    "react_to_message",
    "read_channel",
    "edit_message",
    "delete_message",
    "pin_message",
    "unpin_message",
    "list_channels",
    "get_user_info",
    "list_pins",
    "emoji_list",
    # Providers
    "channel_state_provider",
    "workspace_info_provider",
    "member_list_provider",
]


def get_plugin():
    """Return the Slack plugin configuration."""
    return {
        "name": "slack",
        "description": "Slack integration plugin for elizaOS with Socket Mode support",
        "services": [SlackService],
        "actions": [
            send_message,
            react_to_message,
            read_channel,
            edit_message,
            delete_message,
            pin_message,
            unpin_message,
            list_channels,
            get_user_info,
            list_pins,
            emoji_list,
        ],
        "providers": [
            channel_state_provider,
            workspace_info_provider,
            member_list_provider,
        ],
    }
