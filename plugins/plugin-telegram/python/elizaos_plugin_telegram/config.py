import json
import os
from typing import Literal

from pydantic import BaseModel, Field


UpdateMode = Literal["polling", "webhook"]


class TelegramConfig(BaseModel):
    """Configuration for the Telegram plugin."""
    
    bot_token: str
    api_root: str = Field(default="https://api.telegram.org")
    update_mode: UpdateMode = Field(default="polling")
    webhook_url: str | None = None
    webhook_path: str = Field(default="/telegram/webhook")
    webhook_port: int | None = None
    webhook_secret: str | None = None
    allowed_chats: list[str] = Field(default_factory=list)
    proxy_url: str | None = None
    drop_pending_updates: bool = True
    should_ignore_bot_messages: bool = True
    should_respond_only_to_mentions: bool = False

    @classmethod
    def from_env(cls) -> "TelegramConfig":
        """Load configuration from environment variables."""
        bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
        if not bot_token:
            raise ValueError("TELEGRAM_BOT_TOKEN environment variable is required")

        api_root = os.getenv("TELEGRAM_API_ROOT", "https://api.telegram.org")
        update_mode = os.getenv("TELEGRAM_UPDATE_MODE", "polling")
        if update_mode not in ("polling", "webhook"):
            update_mode = "polling"
        
        webhook_url = os.getenv("TELEGRAM_WEBHOOK_URL")
        webhook_path = os.getenv("TELEGRAM_WEBHOOK_PATH", "/telegram/webhook")
        webhook_port_str = os.getenv("TELEGRAM_WEBHOOK_PORT")
        webhook_port = int(webhook_port_str) if webhook_port_str else None
        webhook_secret = os.getenv("TELEGRAM_WEBHOOK_SECRET")
        
        proxy_url = os.getenv("TELEGRAM_PROXY_URL")
        
        drop_pending = os.getenv("TELEGRAM_DROP_PENDING_UPDATES", "true").lower() == "true"
        ignore_bots = os.getenv("TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES", "true").lower() == "true"
        mentions_only = os.getenv("TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS", "false").lower() == "true"

        allowed_chats_str = os.getenv("TELEGRAM_ALLOWED_CHATS", "[]")
        allowed_chats = _parse_allowed_chats(allowed_chats_str)

        return cls(
            bot_token=bot_token,
            api_root=api_root,
            update_mode=update_mode,  # type: ignore[arg-type]
            webhook_url=webhook_url,
            webhook_path=webhook_path,
            webhook_port=webhook_port,
            webhook_secret=webhook_secret,
            allowed_chats=allowed_chats,
            proxy_url=proxy_url,
            drop_pending_updates=drop_pending,
            should_ignore_bot_messages=ignore_bots,
            should_respond_only_to_mentions=mentions_only,
        )

    def is_chat_allowed(self, chat_id: str) -> bool:
        """Check if a chat ID is in the allowed list."""
        if not self.allowed_chats:
            return True
        return chat_id in self.allowed_chats


def _parse_allowed_chats(value: str) -> list[str]:
    """Parse allowed chats from JSON or comma-separated string."""
    if not value:
        return []
    
    trimmed = value.strip()
    if not trimmed:
        return []
    
    # Try parsing as JSON array first
    if trimmed.startswith("["):
        try:
            parsed = json.loads(trimmed)
            if isinstance(parsed, list):
                return [str(item) for item in parsed if item]
        except json.JSONDecodeError:
            pass
    
    # Otherwise parse as comma-separated
    return [s.strip() for s in trimmed.split(",") if s.strip()]
