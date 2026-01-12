from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ButtonKind(str, Enum):
    LOGIN = "login"
    URL = "url"


class Button(BaseModel):
    kind: ButtonKind
    text: str
    url: str


class TelegramContent(BaseModel):
    text: str | None = None
    buttons: list[Button] = Field(default_factory=list)


class TelegramEventType(str, Enum):
    WORLD_JOINED = "TELEGRAM_WORLD_JOINED"
    WORLD_CONNECTED = "TELEGRAM_WORLD_CONNECTED"
    WORLD_LEFT = "TELEGRAM_WORLD_LEFT"
    ENTITY_JOINED = "TELEGRAM_ENTITY_JOINED"
    ENTITY_LEFT = "TELEGRAM_ENTITY_LEFT"
    ENTITY_UPDATED = "TELEGRAM_ENTITY_UPDATED"
    MESSAGE_RECEIVED = "TELEGRAM_MESSAGE_RECEIVED"
    MESSAGE_SENT = "TELEGRAM_MESSAGE_SENT"
    REACTION_RECEIVED = "TELEGRAM_REACTION_RECEIVED"
    INTERACTION_RECEIVED = "TELEGRAM_INTERACTION_RECEIVED"
    SLASH_START = "TELEGRAM_SLASH_START"


class TelegramChannelType(str, Enum):
    PRIVATE = "private"
    GROUP = "group"
    SUPERGROUP = "supergroup"
    CHANNEL = "channel"


class TelegramUser(BaseModel):
    id: int
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    is_bot: bool = False


class TelegramChat(BaseModel):
    id: int
    type: TelegramChannelType
    title: str | None = None
    username: str | None = None
    first_name: str | None = None
    is_forum: bool = False


class TelegramMessagePayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message_id: int
    chat: TelegramChat
    from_user: TelegramUser | None = Field(default=None, alias="from")
    text: str | None = None
    date: int
    thread_id: int | None = None


class TelegramReactionPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message_id: int
    chat: TelegramChat
    from_user: TelegramUser | None = Field(default=None, alias="from")
    reaction: str
    date: int


class TelegramWorldPayload(BaseModel):
    chat: TelegramChat
    bot_username: str | None = None


class TelegramEntityPayload(BaseModel):
    user: TelegramUser
    chat: TelegramChat
    action: Literal["joined", "left", "updated"]
