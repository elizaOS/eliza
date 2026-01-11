"""
elizaOS Telegram Plugin

Telegram bot integration for elizaOS agents, supporting private chats,
groups, supergroups, and forum topics.
"""

from elizaos_plugin_telegram.config import TelegramConfig
from elizaos_plugin_telegram.error import (
    AuthorizationError,
    BotNotInitializedError,
    ConfigError,
    MessageSendError,
    TelegramError,
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
    # Config
    "TelegramConfig",
    # Errors
    "TelegramError",
    "AuthorizationError",
    "BotNotInitializedError",
    "ConfigError",
    "MessageSendError",
    # Types
    "Button",
    "ButtonKind",
    "TelegramChannelType",
    "TelegramContent",
    "TelegramEntityPayload",
    "TelegramEventType",
    "TelegramMessagePayload",
    "TelegramReactionPayload",
    "TelegramWorldPayload",
    # Service
    "TelegramService",
]

__version__ = "1.0.0"
PLUGIN_NAME = "telegram"
PLUGIN_DESCRIPTION = "Telegram bot integration for elizaOS agents"
