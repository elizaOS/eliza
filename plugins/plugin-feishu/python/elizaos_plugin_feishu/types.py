from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class FeishuEventType(str, Enum):
    """Event types emitted by the Feishu plugin."""

    WORLD_JOINED = "FEISHU_WORLD_JOINED"
    WORLD_CONNECTED = "FEISHU_WORLD_CONNECTED"
    WORLD_LEFT = "FEISHU_WORLD_LEFT"
    ENTITY_JOINED = "FEISHU_ENTITY_JOINED"
    ENTITY_LEFT = "FEISHU_ENTITY_LEFT"
    ENTITY_UPDATED = "FEISHU_ENTITY_UPDATED"
    MESSAGE_RECEIVED = "FEISHU_MESSAGE_RECEIVED"
    MESSAGE_SENT = "FEISHU_MESSAGE_SENT"
    REACTION_RECEIVED = "FEISHU_REACTION_RECEIVED"
    INTERACTION_RECEIVED = "FEISHU_INTERACTION_RECEIVED"
    SLASH_START = "FEISHU_SLASH_START"


class FeishuChatType(str, Enum):
    """Feishu chat types."""

    P2P = "p2p"
    GROUP = "group"


class FeishuContent(BaseModel):
    """Feishu message content."""

    text: str | None = None
    card: dict | None = None
    image_key: str | None = None
    file_key: str | None = None


class FeishuUser(BaseModel):
    """Feishu user information."""

    open_id: str
    union_id: str | None = None
    user_id: str | None = None
    name: str | None = None
    avatar_url: str | None = None
    is_bot: bool = False

    def display_name(self) -> str:
        """Returns a human-friendly display name."""
        return self.name or self.open_id


class FeishuChat(BaseModel):
    """Feishu chat information."""

    chat_id: str
    type: FeishuChatType = Field(alias="chat_type")
    name: str | None = None
    owner_open_id: str | None = None
    description: str | None = None
    tenant_key: str | None = None

    model_config = ConfigDict(populate_by_name=True)

    def display_name(self) -> str:
        """Returns a human-friendly display name."""
        return self.name or self.chat_id


class FeishuMention(BaseModel):
    """Mention information in a message."""

    key: str
    id: str
    id_type: str
    name: str
    tenant_key: str | None = None


class FeishuMessagePayload(BaseModel):
    """Payload for message events."""

    model_config = ConfigDict(populate_by_name=True)

    message_id: str
    root_id: str | None = None
    parent_id: str | None = None
    msg_type: str
    content: str
    create_time: str
    chat: FeishuChat
    sender: FeishuUser | None = None
    mentions: list[FeishuMention] | None = None


class FeishuReactionPayload(BaseModel):
    """Payload for reaction events."""

    model_config = ConfigDict(populate_by_name=True)

    message_id: str
    chat: FeishuChat
    user: FeishuUser | None = None
    reaction_type: str


class FeishuWorldPayload(BaseModel):
    """Payload for world/chat events."""

    chat: FeishuChat
    bot_open_id: str | None = None


class FeishuEntityPayload(BaseModel):
    """Payload for entity (user) events."""

    user: FeishuUser
    chat: FeishuChat
    action: Literal["joined", "left", "updated"]


class FeishuInteractionPayload(BaseModel):
    """Payload for interaction events (card actions)."""

    interaction_type: str
    action_tag: str
    action_value: dict | None = None
    user: FeishuUser
    chat: FeishuChat | None = None
    token: str | None = None
