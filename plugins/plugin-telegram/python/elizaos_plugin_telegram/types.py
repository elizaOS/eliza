"""Type definitions for the Telegram plugin."""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class ButtonKind(str, Enum):
    """Button type."""

    LOGIN = "login"
    URL = "url"


class Button(BaseModel):
    """Represents a flexible button configuration."""

    kind: ButtonKind
    text: str
    url: str


class TelegramContent(BaseModel):
    """Extension of the core Content type for Telegram."""

    text: str | None = None
    buttons: list[Button] = Field(default_factory=list)


class TelegramEventType(str, Enum):
    """Telegram-specific event types."""

    # World events
    WORLD_JOINED = "TELEGRAM_WORLD_JOINED"
    WORLD_CONNECTED = "TELEGRAM_WORLD_CONNECTED"
    WORLD_LEFT = "TELEGRAM_WORLD_LEFT"

    # Entity events
    ENTITY_JOINED = "TELEGRAM_ENTITY_JOINED"
    ENTITY_LEFT = "TELEGRAM_ENTITY_LEFT"
    ENTITY_UPDATED = "TELEGRAM_ENTITY_UPDATED"

    # Message events
    MESSAGE_RECEIVED = "TELEGRAM_MESSAGE_RECEIVED"
    MESSAGE_SENT = "TELEGRAM_MESSAGE_SENT"

    # Interaction events
    REACTION_RECEIVED = "TELEGRAM_REACTION_RECEIVED"
    INTERACTION_RECEIVED = "TELEGRAM_INTERACTION_RECEIVED"

    # Command events
    SLASH_START = "TELEGRAM_SLASH_START"


class TelegramChannelType(str, Enum):
    """Telegram channel types."""

    PRIVATE = "private"
    GROUP = "group"
    SUPERGROUP = "supergroup"
    CHANNEL = "channel"


class TelegramUser(BaseModel):
    """Telegram user information."""

    id: int
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    is_bot: bool = False


class TelegramChat(BaseModel):
    """Telegram chat information."""

    id: int
    type: TelegramChannelType
    title: str | None = None
    username: str | None = None
    first_name: str | None = None
    is_forum: bool = False


class TelegramMessagePayload(BaseModel):
    """Telegram message payload."""

    message_id: int
    chat: TelegramChat
    from_user: TelegramUser | None = Field(default=None, alias="from")
    text: str | None = None
    date: int
    thread_id: int | None = None

    class Config:
        """Pydantic configuration."""

        populate_by_name = True


class TelegramReactionPayload(BaseModel):
    """Telegram reaction payload."""

    message_id: int
    chat: TelegramChat
    from_user: TelegramUser | None = Field(default=None, alias="from")
    reaction: str
    date: int

    class Config:
        """Pydantic configuration."""

        populate_by_name = True


class TelegramWorldPayload(BaseModel):
    """Telegram world payload."""

    chat: TelegramChat
    bot_username: str | None = None


class TelegramEntityPayload(BaseModel):
    """Telegram entity payload."""

    user: TelegramUser
    chat: TelegramChat
    action: Literal["joined", "left", "updated"]
