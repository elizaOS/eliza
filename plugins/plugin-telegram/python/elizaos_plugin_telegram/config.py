"""Configuration for the Telegram plugin."""

import json
import os

from pydantic import BaseModel, Field


class TelegramConfig(BaseModel):
    """Configuration for the Telegram client."""

    bot_token: str
    api_root: str = Field(default="https://api.telegram.org")
    allowed_chats: list[str] = Field(default_factory=list)

    @classmethod
    def from_env(cls) -> "TelegramConfig":
        """Create configuration from environment variables.

        Environment variables:
            TELEGRAM_BOT_TOKEN: Bot API token (required)
            TELEGRAM_API_ROOT: Custom API root URL
            TELEGRAM_ALLOWED_CHATS: JSON array of allowed chat IDs

        Returns:
            TelegramConfig instance

        Raises:
            ValueError: If TELEGRAM_BOT_TOKEN is not set
        """
        bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
        if not bot_token:
            raise ValueError("TELEGRAM_BOT_TOKEN environment variable is required")

        api_root = os.getenv("TELEGRAM_API_ROOT", "https://api.telegram.org")

        allowed_chats_str = os.getenv("TELEGRAM_ALLOWED_CHATS", "[]")
        try:
            allowed_chats = json.loads(allowed_chats_str)
            if not isinstance(allowed_chats, list):
                allowed_chats = []
        except json.JSONDecodeError:
            allowed_chats = []

        return cls(
            bot_token=bot_token,
            api_root=api_root,
            allowed_chats=allowed_chats,
        )

    def is_chat_allowed(self, chat_id: str) -> bool:
        """Check if a chat is allowed.

        Args:
            chat_id: The chat ID to check

        Returns:
            True if the chat is allowed or no restrictions are set
        """
        if not self.allowed_chats:
            return True
        return chat_id in self.allowed_chats
