"""Zalo Official Account Bot API plugin for elizaOS."""

from elizaos_plugin_zalo.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)
from elizaos_plugin_zalo.config import ZaloConfig
from elizaos_plugin_zalo.error import (
    ApiError,
    ClientNotInitializedError,
    ConfigError,
    MessageSendError,
    TokenRefreshError,
    UserNotFoundError,
    ZaloError,
)
from elizaos_plugin_zalo.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_zalo.service import ZaloService
from elizaos_plugin_zalo.types import (
    ZaloBotProbe,
    ZaloBotStatusPayload,
    ZaloChat,
    ZaloContent,
    ZaloEventType,
    ZaloFollowPayload,
    ZaloMessage,
    ZaloMessagePayload,
    ZaloOAInfo,
    ZaloSendImageParams,
    ZaloSendMessageParams,
    ZaloUpdate,
    ZaloUser,
    ZaloWebhookPayload,
)

__all__ = [
    # Config
    "ZaloConfig",
    # Errors
    "ZaloError",
    "ApiError",
    "ClientNotInitializedError",
    "ConfigError",
    "MessageSendError",
    "TokenRefreshError",
    "UserNotFoundError",
    # Types
    "ZaloBotProbe",
    "ZaloBotStatusPayload",
    "ZaloChat",
    "ZaloContent",
    "ZaloEventType",
    "ZaloFollowPayload",
    "ZaloMessage",
    "ZaloMessagePayload",
    "ZaloOAInfo",
    "ZaloSendImageParams",
    "ZaloSendMessageParams",
    "ZaloUpdate",
    "ZaloUser",
    "ZaloWebhookPayload",
    # Service
    "ZaloService",
    # Actions
    "SEND_MESSAGE_ACTION",
    "SendMessageResult",
    "handle_send_message",
    # Providers
    "CHAT_STATE_PROVIDER",
    "ChatStateResult",
    "get_chat_state",
]

__version__ = "2.0.0"
PLUGIN_NAME = "zalo"
PLUGIN_DESCRIPTION = "Zalo Official Account Bot API integration for elizaOS agents"
