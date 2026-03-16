"""Type definitions for the Zalo User plugin."""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ZaloUserEventType(str, Enum):
    """Event types emitted by the Zalo User plugin."""

    WORLD_JOINED = "ZALOUSER_WORLD_JOINED"
    WORLD_CONNECTED = "ZALOUSER_WORLD_CONNECTED"
    WORLD_LEFT = "ZALOUSER_WORLD_LEFT"
    ENTITY_JOINED = "ZALOUSER_ENTITY_JOINED"
    ENTITY_LEFT = "ZALOUSER_ENTITY_LEFT"
    ENTITY_UPDATED = "ZALOUSER_ENTITY_UPDATED"
    MESSAGE_RECEIVED = "ZALOUSER_MESSAGE_RECEIVED"
    MESSAGE_SENT = "ZALOUSER_MESSAGE_SENT"
    REACTION_RECEIVED = "ZALOUSER_REACTION_RECEIVED"
    REACTION_SENT = "ZALOUSER_REACTION_SENT"
    QR_CODE_READY = "ZALOUSER_QR_CODE_READY"
    LOGIN_SUCCESS = "ZALOUSER_LOGIN_SUCCESS"
    LOGIN_FAILED = "ZALOUSER_LOGIN_FAILED"
    CLIENT_STARTED = "ZALOUSER_CLIENT_STARTED"
    CLIENT_STOPPED = "ZALOUSER_CLIENT_STOPPED"


class ZaloUserChatType(str, Enum):
    """Zalo chat type."""

    PRIVATE = "private"
    GROUP = "group"


class ZaloUser(BaseModel):
    """Zalo user information."""

    id: str
    display_name: str = Field(alias="displayName")
    username: str | None = None
    avatar: str | None = None
    is_self: bool = Field(default=False, alias="isSelf")

    model_config = ConfigDict(populate_by_name=True)


class ZaloChat(BaseModel):
    """Zalo chat/conversation information."""

    thread_id: str = Field(alias="threadId")
    type: ZaloUserChatType
    name: str | None = None
    avatar: str | None = None
    member_count: int | None = Field(default=None, alias="memberCount")
    is_group: bool = Field(default=False, alias="isGroup")

    model_config = ConfigDict(populate_by_name=True)


class ZaloFriend(BaseModel):
    """Zalo friend entry."""

    user_id: str = Field(alias="userId")
    display_name: str = Field(alias="displayName")
    avatar: str | None = None
    phone_number: str | None = Field(default=None, alias="phoneNumber")

    model_config = ConfigDict(populate_by_name=True)


class ZaloGroup(BaseModel):
    """Zalo group entry."""

    group_id: str = Field(alias="groupId")
    name: str
    member_count: int | None = Field(default=None, alias="memberCount")
    avatar: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class ZaloMessageMetadata(BaseModel):
    """Zalo message metadata."""

    is_group: bool = Field(default=False, alias="isGroup")
    thread_name: str | None = Field(default=None, alias="threadName")
    sender_name: str | None = Field(default=None, alias="senderName")
    sender_id: str | None = Field(default=None, alias="fromId")

    model_config = ConfigDict(populate_by_name=True)


class ZaloMessage(BaseModel):
    """Zalo message."""

    msg_id: str | None = Field(default=None, alias="msgId")
    cli_msg_id: str | None = Field(default=None, alias="cliMsgId")
    thread_id: str = Field(alias="threadId")
    type: int
    content: str
    timestamp: int
    metadata: ZaloMessageMetadata | None = None

    model_config = ConfigDict(populate_by_name=True)


class ZaloMessagePayload(BaseModel):
    """Zalo message payload for events."""

    message: ZaloMessage
    chat: ZaloChat
    sender: ZaloUser | None = None


class ZaloWorldPayload(BaseModel):
    """Zalo world/chat payload for events."""

    chat: ZaloChat
    current_user: ZaloUser | None = Field(default=None, alias="currentUser")

    model_config = ConfigDict(populate_by_name=True)


class ZaloUserInfo(BaseModel):
    """Authenticated user info."""

    user_id: str = Field(alias="userId")
    display_name: str = Field(alias="displayName")
    avatar: str | None = None
    phone_number: str | None = Field(default=None, alias="phoneNumber")

    model_config = ConfigDict(populate_by_name=True)


class ZaloUserProbe(BaseModel):
    """Probe result for health checks."""

    ok: bool
    user: ZaloUser | None = None
    error: str | None = None
    latency_ms: int


class ZaloUserClientStatus(BaseModel):
    """Client status payload."""

    profile: str | None = None
    user: ZaloUser | None = None
    running: bool
    timestamp: int


class ZaloUserQrCodePayload(BaseModel):
    """QR code ready payload."""

    qr_data_url: str | None = Field(default=None, alias="qrDataUrl")
    message: str
    profile: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class SendMessageParams(BaseModel):
    """Send message parameters."""

    thread_id: str = Field(alias="threadId")
    text: str
    is_group: bool = Field(default=False, alias="isGroup")
    profile: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class SendMessageResult(BaseModel):
    """Send message result."""

    success: bool
    thread_id: str = Field(alias="threadId")
    message_id: str | None = Field(default=None, alias="messageId")
    error: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class SendMediaParams(BaseModel):
    """Send media parameters."""

    thread_id: str = Field(alias="threadId")
    media_url: str = Field(alias="mediaUrl")
    caption: str | None = None
    is_group: bool = Field(default=False, alias="isGroup")
    profile: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class ZaloUserProfile(BaseModel):
    """Zalo profile configuration."""

    name: str
    label: str | None = None
    is_default: bool = Field(default=False, alias="isDefault")
    cookie_path: str | None = Field(default=None, alias="cookiePath")
    imei: str | None = None
    user_agent: str | None = Field(default=None, alias="userAgent")

    model_config = ConfigDict(populate_by_name=True)


# Type aliases
DmPolicy = Literal["open", "allowlist", "pairing", "disabled"]
GroupPolicy = Literal["open", "allowlist", "disabled"]
