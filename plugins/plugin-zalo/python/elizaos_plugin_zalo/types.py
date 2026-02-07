"""Serializable types used for events and payloads."""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class ZaloEventType(str, Enum):
    """Event types emitted by the Zalo plugin."""

    BOT_STARTED = "ZALO_BOT_STARTED"
    BOT_STOPPED = "ZALO_BOT_STOPPED"
    MESSAGE_RECEIVED = "ZALO_MESSAGE_RECEIVED"
    MESSAGE_SENT = "ZALO_MESSAGE_SENT"
    WEBHOOK_REGISTERED = "ZALO_WEBHOOK_REGISTERED"
    USER_FOLLOWED = "ZALO_USER_FOLLOWED"
    USER_UNFOLLOWED = "ZALO_USER_UNFOLLOWED"
    TOKEN_REFRESHED = "ZALO_TOKEN_REFRESHED"


class ZaloUser(BaseModel):
    """Zalo user information."""

    id: str
    name: str | None = None
    avatar: str | None = None

    def display_name(self) -> str:
        """Returns a display name for the user."""
        return self.name or self.id


class ZaloChat(BaseModel):
    """Zalo chat information (always DM for OA)."""

    id: str
    chat_type: Literal["PRIVATE"] = "PRIVATE"


class ZaloMessage(BaseModel):
    """Zalo message structure."""

    message_id: str
    from_user: ZaloUser = Field(alias="from")
    chat: ZaloChat
    date: int
    text: str | None = None
    photo: str | None = None
    caption: str | None = None
    sticker: str | None = None

    model_config = {"populate_by_name": True}


class ZaloOAInfo(BaseModel):
    """Zalo Official Account information."""

    oa_id: str
    name: str
    description: str | None = None
    avatar: str | None = None
    cover: str | None = None


class ZaloApiResponse(BaseModel):
    """Zalo API response wrapper."""

    error: int
    message: str
    data: dict | None = None


class ZaloSendMessageParams(BaseModel):
    """Parameters for sending a text message."""

    user_id: str
    text: str


class ZaloSendImageParams(BaseModel):
    """Parameters for sending an image message."""

    user_id: str
    image_url: str
    caption: str | None = None


class ZaloBotProbe(BaseModel):
    """Result of probing the Zalo OA connection."""

    ok: bool
    oa: ZaloOAInfo | None = None
    error: str | None = None
    latency_ms: int


class ZaloBotStatusPayload(BaseModel):
    """Bot status payload for start/stop events."""

    oa_id: str | None = None
    oa_name: str | None = None
    update_mode: Literal["polling", "webhook"]
    timestamp: int


class ZaloWebhookPayload(BaseModel):
    """Webhook registration payload."""

    url: str
    path: str
    port: int | None = None
    timestamp: int


class ZaloMessagePayload(BaseModel):
    """Message payload for events."""

    message_id: str
    chat: ZaloChat
    from_user: ZaloUser | None = None
    text: str | None = None
    date: int


class ZaloFollowPayload(BaseModel):
    """User follow/unfollow payload."""

    user_id: str
    action: Literal["follow", "unfollow"]
    timestamp: int


class ZaloContent(BaseModel):
    """Zalo message content extension."""

    text: str | None = None
    image_url: str | None = None
    caption: str | None = None


class ZaloUpdate(BaseModel):
    """Zalo webhook update event."""

    event_name: str
    message: ZaloMessage | None = None
    user_id: str | None = None
    timestamp: int | None = None
