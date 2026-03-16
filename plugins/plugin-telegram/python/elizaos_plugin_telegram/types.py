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
    REACTION_SENT = "TELEGRAM_REACTION_SENT"
    INTERACTION_RECEIVED = "TELEGRAM_INTERACTION_RECEIVED"
    SLASH_START = "TELEGRAM_SLASH_START"
    BOT_STARTED = "TELEGRAM_BOT_STARTED"
    BOT_STOPPED = "TELEGRAM_BOT_STOPPED"
    WEBHOOK_REGISTERED = "TELEGRAM_WEBHOOK_REGISTERED"


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


class TelegramBotInfo(BaseModel):
    """Extended bot information from getMe."""
    id: int
    username: str | None = None
    first_name: str
    can_join_groups: bool = False
    can_read_all_group_messages: bool = False
    supports_inline_queries: bool = False


class TelegramBotProbe(BaseModel):
    """Result of probing the Telegram bot connection."""
    ok: bool
    bot: TelegramBotInfo | None = None
    error: str | None = None
    latency_ms: int


class SendReactionParams(BaseModel):
    """Parameters for sending a reaction."""
    chat_id: int | str
    message_id: int
    reaction: str
    is_big: bool = False


class SendReactionResult(BaseModel):
    """Result of sending a reaction."""
    success: bool
    chat_id: int | str
    message_id: int
    reaction: str
    error: str | None = None


class TelegramBotStatusPayload(BaseModel):
    """Payload for bot status events."""
    bot_id: int | None = None
    bot_username: str | None = None
    bot_name: str | None = None
    update_mode: Literal["polling", "webhook"]
    timestamp: int


class TelegramWebhookPayload(BaseModel):
    """Payload for webhook registration events."""
    url: str
    path: str
    port: int | None = None
    has_secret: bool
    timestamp: int


class TelegramWebhookInfo(BaseModel):
    """Webhook configuration info from Telegram."""
    url: str
    has_custom_certificate: bool
    pending_update_count: int
    last_error_date: int | None = None
    last_error_message: str | None = None
    max_connections: int | None = None
    allowed_updates: list[str] | None = None


# Common reaction emojis supported by Telegram
class TelegramReactions:
    THUMBS_UP = "👍"
    THUMBS_DOWN = "👎"
    HEART = "❤"
    FIRE = "🔥"
    CELEBRATION = "🎉"
    CRYING = "😢"
    THINKING = "🤔"
    EXPLODING_HEAD = "🤯"
    SCREAMING = "😱"
    ANGRY = "🤬"
    SKULL = "💀"
    POOP = "💩"
    CLOWN = "🤡"
    QUESTION = "🤨"
    EYES = "👀"
    WHALE = "🐳"
    HEART_ON_FIRE = "❤️‍🔥"
    NEW_MOON = "🌚"
    HOT_DOG = "🌭"
    HUNDRED = "💯"
    TEARS_OF_JOY = "😂"
    LIGHTNING = "⚡"
    BANANA = "🍌"
    TROPHY = "🏆"
    BROKEN_HEART = "💔"
    NEUTRAL = "😐"
    STRAWBERRY = "🍓"
    CHAMPAGNE = "🍾"
    KISS = "💋"
    DEVIL = "😈"
    SLEEPING = "😴"
    LOUDLY_CRYING = "😭"
    NERD = "🤓"
    GHOST = "👻"
    TECHNOLOGIST = "👨‍💻"
    UNICORN = "🦄"
