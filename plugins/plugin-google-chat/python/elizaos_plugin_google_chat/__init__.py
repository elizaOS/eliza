"""
Google Chat Plugin for elizaOS

Provides Google Chat messaging integration for elizaOS agents,
supporting spaces, direct messages, threads, and reactions.
"""

from .actions import (
    list_spaces_action,
    send_message_action,
    send_reaction_action,
)
from .providers import (
    space_state_provider,
    user_context_provider,
)
from .service import GoogleChatService
from .types import (
    GOOGLE_CHAT_SERVICE_NAME,
    MAX_GOOGLE_CHAT_MESSAGE_LENGTH,
    GoogleChatApiError,
    GoogleChatAuthenticationError,
    GoogleChatConfigurationError,
    GoogleChatEvent,
    GoogleChatEventTypes,
    GoogleChatMessage,
    GoogleChatMessageSendOptions,
    GoogleChatPluginError,
    GoogleChatReaction,
    GoogleChatSendResult,
    GoogleChatSettings,
    GoogleChatSpace,
    GoogleChatUser,
    extract_resource_id,
    get_space_display_name,
    get_user_display_name,
    is_direct_message,
    is_valid_google_chat_space_name,
    is_valid_google_chat_user_name,
    normalize_space_target,
    normalize_user_target,
    split_message_for_google_chat,
)


def get_plugin():
    """Get the Google Chat plugin definition for elizaOS."""
    return {
        "name": "google-chat",
        "description": "Google Chat integration plugin for elizaOS agents",
        "services": [GoogleChatService],
        "actions": [
            send_message_action,
            send_reaction_action,
            list_spaces_action,
        ],
        "providers": [
            space_state_provider,
            user_context_provider,
        ],
        "tests": [],
    }


__all__ = [
    # Types
    "GoogleChatSettings",
    "GoogleChatSpace",
    "GoogleChatUser",
    "GoogleChatMessage",
    "GoogleChatEvent",
    "GoogleChatReaction",
    "GoogleChatMessageSendOptions",
    "GoogleChatSendResult",
    "GoogleChatEventTypes",
    "GoogleChatPluginError",
    "GoogleChatConfigurationError",
    "GoogleChatApiError",
    "GoogleChatAuthenticationError",
    "GOOGLE_CHAT_SERVICE_NAME",
    "MAX_GOOGLE_CHAT_MESSAGE_LENGTH",
    # Utilities
    "is_valid_google_chat_space_name",
    "is_valid_google_chat_user_name",
    "normalize_space_target",
    "normalize_user_target",
    "extract_resource_id",
    "get_user_display_name",
    "get_space_display_name",
    "is_direct_message",
    "split_message_for_google_chat",
    # Service
    "GoogleChatService",
    # Actions
    "send_message_action",
    "send_reaction_action",
    "list_spaces_action",
    # Providers
    "space_state_provider",
    "user_context_provider",
    # Plugin
    "get_plugin",
]
