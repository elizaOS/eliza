from elizaos_plugin_telegram.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)
from elizaos_plugin_telegram.config import TelegramConfig
from elizaos_plugin_telegram.error import (
    AuthorizationError,
    BotNotInitializedError,
    ConfigError,
    MessageSendError,
    TelegramError,
)
from elizaos_plugin_telegram.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_telegram.service import TelegramService
from elizaos_plugin_telegram.types import (
    Button,
    ButtonKind,
    TelegramChannelType,
    TelegramContent,
    TelegramEntityPayload,
    TelegramEventType,
    TelegramMessagePayload,
    TelegramReactionPayload,
    TelegramWorldPayload,
)

__all__ = [
    "TelegramConfig",
    "TelegramError",
    "AuthorizationError",
    "BotNotInitializedError",
    "ConfigError",
    "MessageSendError",
    "Button",
    "ButtonKind",
    "TelegramChannelType",
    "TelegramContent",
    "TelegramEntityPayload",
    "TelegramEventType",
    "TelegramMessagePayload",
    "TelegramReactionPayload",
    "TelegramWorldPayload",
    "TelegramService",
    "SEND_MESSAGE_ACTION",
    "SendMessageResult",
    "handle_send_message",
    "CHAT_STATE_PROVIDER",
    "ChatStateResult",
    "get_chat_state",
]

__version__ = "1.0.0"
PLUGIN_NAME = "telegram"
PLUGIN_DESCRIPTION = "Telegram bot integration for elizaOS agents"
