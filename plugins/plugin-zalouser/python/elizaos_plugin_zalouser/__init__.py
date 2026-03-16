"""Zalo User plugin for elizaOS - Python implementation via zca-cli."""

from elizaos_plugin_zalouser.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageActionResult,
    handle_send_message,
    validate_send_message,
)
from elizaos_plugin_zalouser.config import (
    DEFAULT_PROFILE,
    DEFAULT_TIMEOUT_MS,
    MAX_MESSAGE_LENGTH,
    ZaloUserConfig,
)
from elizaos_plugin_zalouser.error import (
    AlreadyRunningError,
    ApiError,
    ChatNotFoundError,
    ClientNotInitializedError,
    CommandError,
    InvalidArgumentError,
    InvalidConfigError,
    NotAuthenticatedError,
    NotRunningError,
    SendError,
    TimeoutError,
    UserNotFoundError,
    ZaloUserError,
    ZcaNotInstalledError,
)
from elizaos_plugin_zalouser.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_zalouser.service import ZaloUserService
from elizaos_plugin_zalouser.types import (
    SendMediaParams,
    SendMessageParams,
    SendMessageResult,
    ZaloChat,
    ZaloFriend,
    ZaloGroup,
    ZaloMessage,
    ZaloMessageMetadata,
    ZaloMessagePayload,
    ZaloUser,
    ZaloUserChatType,
    ZaloUserClientStatus,
    ZaloUserEventType,
    ZaloUserInfo,
    ZaloUserProbe,
    ZaloUserProfile,
    ZaloUserQrCodePayload,
    ZaloWorldPayload,
)

__all__ = [
    # Config
    "ZaloUserConfig",
    "DEFAULT_PROFILE",
    "DEFAULT_TIMEOUT_MS",
    "MAX_MESSAGE_LENGTH",
    # Errors
    "ZaloUserError",
    "ZcaNotInstalledError",
    "NotAuthenticatedError",
    "InvalidConfigError",
    "AlreadyRunningError",
    "NotRunningError",
    "ClientNotInitializedError",
    "ConnectionError",
    "CommandError",
    "TimeoutError",
    "ApiError",
    "SendError",
    "ChatNotFoundError",
    "UserNotFoundError",
    "InvalidArgumentError",
    # Types
    "ZaloUserEventType",
    "ZaloUserChatType",
    "ZaloUser",
    "ZaloChat",
    "ZaloFriend",
    "ZaloGroup",
    "ZaloMessage",
    "ZaloMessageMetadata",
    "ZaloMessagePayload",
    "ZaloWorldPayload",
    "ZaloUserInfo",
    "ZaloUserProbe",
    "ZaloUserClientStatus",
    "ZaloUserQrCodePayload",
    "SendMessageParams",
    "SendMessageResult",
    "SendMediaParams",
    "ZaloUserProfile",
    # Service
    "ZaloUserService",
    # Actions
    "SEND_MESSAGE_ACTION",
    "SendMessageActionResult",
    "handle_send_message",
    "validate_send_message",
    # Providers
    "CHAT_STATE_PROVIDER",
    "ChatStateResult",
    "get_chat_state",
]

__version__ = "2.0.0"
PLUGIN_NAME = "zalouser"
PLUGIN_DESCRIPTION = "Zalo personal account integration for elizaOS agents via zca-cli"
