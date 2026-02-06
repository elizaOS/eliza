"""
LINE Messaging API plugin for ElizaOS agents.
"""

from .actions import (
    send_flex_message_action,
    send_location_action,
    send_message_action,
)
from .providers import (
    chat_context_provider,
    user_context_provider,
)
from .service import LineService
from .types import (
    LINE_SERVICE_NAME,
    MAX_LINE_BATCH_SIZE,
    MAX_LINE_MESSAGE_LENGTH,
    LineApiError,
    LineConfigurationError,
    LineEventTypes,
    LineFlexMessage,
    LineGroup,
    LineLocationMessage,
    LineMessage,
    LinePluginError,
    LineSendResult,
    LineSettings,
    LineTemplateMessage,
    LineUser,
    get_chat_type_from_id,
    is_valid_line_group_id,
    is_valid_line_id,
    is_valid_line_room_id,
    is_valid_line_user_id,
    normalize_line_target,
    split_message_for_line,
)

__all__ = [
    # Constants
    "MAX_LINE_MESSAGE_LENGTH",
    "MAX_LINE_BATCH_SIZE",
    "LINE_SERVICE_NAME",
    "LineEventTypes",
    # Types
    "LineSettings",
    "LineUser",
    "LineGroup",
    "LineMessage",
    "LineSendResult",
    "LineFlexMessage",
    "LineTemplateMessage",
    "LineLocationMessage",
    # Errors
    "LinePluginError",
    "LineConfigurationError",
    "LineApiError",
    # Utilities
    "is_valid_line_user_id",
    "is_valid_line_group_id",
    "is_valid_line_room_id",
    "is_valid_line_id",
    "normalize_line_target",
    "get_chat_type_from_id",
    "split_message_for_line",
    # Service
    "LineService",
    # Actions
    "send_message_action",
    "send_flex_message_action",
    "send_location_action",
    # Providers
    "chat_context_provider",
    "user_context_provider",
    # Plugin
    "get_plugin",
]


def get_plugin():
    """Get the LINE plugin configuration."""
    return {
        "name": "line",
        "description": "LINE Messaging API plugin for ElizaOS agents",
        "services": [LineService],
        "actions": [
            send_message_action,
            send_flex_message_action,
            send_location_action,
        ],
        "providers": [
            chat_context_provider,
            user_context_provider,
        ],
    }
