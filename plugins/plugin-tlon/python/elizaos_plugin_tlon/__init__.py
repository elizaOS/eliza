"""Tlon/Urbit plugin for elizaOS."""

from elizaos_plugin_tlon.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)
from elizaos_plugin_tlon.client import TlonClient, authenticate
from elizaos_plugin_tlon.config import TlonConfig
from elizaos_plugin_tlon.error import (
    AuthenticationError,
    ClientNotInitializedError,
    ConfigError,
    ConnectionError,
    MessageSendError,
    TlonError,
)
from elizaos_plugin_tlon.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_tlon.service import TlonService
from elizaos_plugin_tlon.types import (
    TlonChannelType,
    TlonChat,
    TlonContent,
    TlonEntityPayload,
    TlonEventType,
    TlonMessagePayload,
    TlonShip,
    TlonWorldPayload,
)

__all__ = [
    # Config
    "TlonConfig",
    # Errors
    "TlonError",
    "AuthenticationError",
    "ClientNotInitializedError",
    "ConfigError",
    "ConnectionError",
    "MessageSendError",
    # Types
    "TlonChannelType",
    "TlonChat",
    "TlonContent",
    "TlonEntityPayload",
    "TlonEventType",
    "TlonMessagePayload",
    "TlonShip",
    "TlonWorldPayload",
    # Client
    "TlonClient",
    "authenticate",
    # Service
    "TlonService",
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
PLUGIN_NAME = "tlon"
PLUGIN_DESCRIPTION = "Tlon/Urbit integration for elizaOS agents"
