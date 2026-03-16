"""Types for the Tlon plugin."""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class TlonEventType(str, Enum):
    """Event types emitted by the Tlon plugin."""

    WORLD_JOINED = "TLON_WORLD_JOINED"
    WORLD_CONNECTED = "TLON_WORLD_CONNECTED"
    WORLD_LEFT = "TLON_WORLD_LEFT"
    ENTITY_JOINED = "TLON_ENTITY_JOINED"
    ENTITY_LEFT = "TLON_ENTITY_LEFT"
    MESSAGE_RECEIVED = "TLON_MESSAGE_RECEIVED"
    MESSAGE_SENT = "TLON_MESSAGE_SENT"
    DM_RECEIVED = "TLON_DM_RECEIVED"
    GROUP_MESSAGE_RECEIVED = "TLON_GROUP_MESSAGE_RECEIVED"
    CONNECTION_ERROR = "TLON_CONNECTION_ERROR"
    RECONNECTED = "TLON_RECONNECTED"


class TlonChannelType(str, Enum):
    """Tlon channel types."""

    DM = "dm"
    GROUP = "group"
    THREAD = "thread"


class TlonShip(BaseModel):
    """Urbit ship information."""

    name: str
    display_name: str | None = None
    avatar: str | None = None

    def formatted(self) -> str:
        """Get the ship name with ~ prefix."""
        return f"~{self.name}"


class TlonChat(BaseModel):
    """Tlon chat/channel information."""

    id: str
    type: TlonChannelType
    name: str | None = None
    host_ship: str | None = None
    description: str | None = None

    @classmethod
    def dm(cls, ship: str) -> TlonChat:
        """Create a DM chat."""
        return cls(
            id=ship,
            type=TlonChannelType.DM,
            name=f"DM with ~{ship}",
        )

    @classmethod
    def group(
        cls, channel_nest: str, name: str | None = None, host_ship: str | None = None
    ) -> TlonChat:
        """Create a group chat."""
        return cls(
            id=channel_nest,
            type=TlonChannelType.GROUP,
            name=name,
            host_ship=host_ship,
        )


class TlonMessagePayload(BaseModel):
    """Payload for received messages."""

    model_config = ConfigDict(populate_by_name=True)

    message_id: str
    chat: TlonChat
    from_ship: TlonShip
    text: str
    timestamp: int
    reply_to_id: str | None = None
    raw_content: Any | None = None


class TlonMessageSentPayload(BaseModel):
    """Payload for sent messages."""

    message_id: str
    chat: TlonChat
    text: str
    is_reply: bool = False


class TlonWorldPayload(BaseModel):
    """Payload for world/connection events."""

    ship: TlonShip
    dm_conversations: list[str] = Field(default_factory=list)
    group_channels: list[str] = Field(default_factory=list)


class TlonEntityPayload(BaseModel):
    """Payload for entity (ship) events."""

    ship: TlonShip
    chat: TlonChat
    action: Literal["joined", "left", "updated"]


class TlonContent(BaseModel):
    """Tlon message content."""

    text: str | None = None
    ship: str | None = None
    channel_nest: str | None = None
    reply_to_id: str | None = None


# Story/content types for Urbit message format
TlonInline = str | dict[str, Any]
TlonVerse = dict[str, Any]
TlonStory = list[TlonVerse]


class TlonMemo(BaseModel):
    """Message memo from Urbit."""

    content: TlonStory
    author: str
    sent: int
