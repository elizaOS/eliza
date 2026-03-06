"""
iMessage plugin for elizaOS agents (macOS).
"""

from .actions import send_message_action
from .providers import chat_context_provider
from .service import IMessageService, parse_chats_from_applescript, parse_messages_from_applescript
from .types import (
    DEFAULT_POLL_INTERVAL_MS,
    IMESSAGE_SERVICE_NAME,
    MAX_IMESSAGE_MESSAGE_LENGTH,
    IMessageChat,
    IMessageCliError,
    IMessageConfigurationError,
    IMessageContact,
    IMessageEventTypes,
    IMessageMessage,
    IMessageNotSupportedError,
    IMessagePluginError,
    IMessageSendResult,
    IMessageSettings,
    format_phone_number,
    is_email,
    is_phone_number,
    is_valid_imessage_target,
    normalize_imessage_target,
    split_message_for_imessage,
)

__all__ = [
    # Constants
    "MAX_IMESSAGE_MESSAGE_LENGTH",
    "DEFAULT_POLL_INTERVAL_MS",
    "IMESSAGE_SERVICE_NAME",
    "IMessageEventTypes",
    # Types
    "IMessageSettings",
    "IMessageContact",
    "IMessageChat",
    "IMessageMessage",
    "IMessageSendResult",
    # Errors
    "IMessagePluginError",
    "IMessageConfigurationError",
    "IMessageNotSupportedError",
    "IMessageCliError",
    # Utilities
    "is_phone_number",
    "is_email",
    "is_valid_imessage_target",
    "normalize_imessage_target",
    "format_phone_number",
    "split_message_for_imessage",
    # Parsing
    "parse_messages_from_applescript",
    "parse_chats_from_applescript",
    # Service
    "IMessageService",
    # Actions
    "send_message_action",
    # Providers
    "chat_context_provider",
    # Plugin
    "get_plugin",
]


def get_plugin():
    """Get the iMessage plugin configuration."""
    return {
        "name": "imessage",
        "description": "iMessage plugin for elizaOS agents (macOS)",
        "services": [IMessageService],
        "actions": [send_message_action],
        "providers": [chat_context_provider],
    }
