from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class NextcloudTalkEventType(str, Enum):
    WORLD_JOINED = "NEXTCLOUD_TALK_WORLD_JOINED"
    WORLD_CONNECTED = "NEXTCLOUD_TALK_WORLD_CONNECTED"
    WORLD_LEFT = "NEXTCLOUD_TALK_WORLD_LEFT"
    MESSAGE_RECEIVED = "NEXTCLOUD_TALK_MESSAGE_RECEIVED"
    MESSAGE_SENT = "NEXTCLOUD_TALK_MESSAGE_SENT"
    REACTION_RECEIVED = "NEXTCLOUD_TALK_REACTION_RECEIVED"
    REACTION_SENT = "NEXTCLOUD_TALK_REACTION_SENT"
    WEBHOOK_RECEIVED = "NEXTCLOUD_TALK_WEBHOOK_RECEIVED"


class NextcloudTalkRoomType(str, Enum):
    ONE_TO_ONE = "one-to-one"
    GROUP = "group"
    PUBLIC = "public"
    CHANGELOG = "changelog"


class NextcloudTalkActor(BaseModel):
    """Actor in the activity (the message sender)."""

    type: str = Field(alias="type", default="Person")
    id: str
    name: str


class NextcloudTalkObject(BaseModel):
    """The message object in the activity."""

    type: str = Field(alias="type", default="Note")
    id: str
    name: str
    content: str
    media_type: str = Field(alias="mediaType", default="text/plain")


class NextcloudTalkTarget(BaseModel):
    """Target conversation/room."""

    type: str = Field(alias="type", default="Collection")
    id: str
    name: str


class NextcloudTalkWebhookPayload(BaseModel):
    """Incoming webhook payload from Nextcloud Talk (Activity Streams 2.0 format)."""

    model_config = ConfigDict(populate_by_name=True)

    type: Literal["Create", "Update", "Delete"]
    actor: NextcloudTalkActor
    object: NextcloudTalkObject
    target: NextcloudTalkTarget


class NextcloudTalkWebhookHeaders(BaseModel):
    """Headers sent by Nextcloud Talk webhook."""

    signature: str
    random: str
    backend: str


class NextcloudTalkUser(BaseModel):
    """User information in Nextcloud Talk."""

    id: str
    display_name: str
    actor_type: str | None = None


class NextcloudTalkRoom(BaseModel):
    """Room/conversation information."""

    token: str
    name: str
    display_name: str
    type: NextcloudTalkRoomType
    participant_count: int | None = None
    last_activity: int | None = None

    def is_group_chat(self) -> bool:
        return self.type in (NextcloudTalkRoomType.GROUP, NextcloudTalkRoomType.PUBLIC)


class NextcloudTalkInboundMessage(BaseModel):
    """Parsed incoming message context."""

    message_id: str
    room_token: str
    room_name: str
    sender_id: str
    sender_name: str
    text: str
    media_type: str
    timestamp: int
    is_group_chat: bool = False


class NextcloudTalkSendResult(BaseModel):
    """Result from sending a message to Nextcloud Talk."""

    message_id: str
    room_token: str
    timestamp: int | None = None


class NextcloudTalkContent(BaseModel):
    """Content with Nextcloud Talk specific fields."""

    text: str | None = None
    room_token: str | None = None
    reply_to: str | None = None
    reaction: str | None = None


class NextcloudTalkMessagePayload(BaseModel):
    """Message payload for events."""

    model_config = ConfigDict(populate_by_name=True)

    message_id: str
    room: NextcloudTalkRoom
    from_user: NextcloudTalkUser | None = Field(default=None, alias="from")
    text: str | None = None
    timestamp: int
    is_group_chat: bool = False


class NextcloudTalkReactionPayload(BaseModel):
    """Reaction payload for events."""

    model_config = ConfigDict(populate_by_name=True)

    message_id: str
    room: NextcloudTalkRoom
    from_user: NextcloudTalkUser | None = Field(default=None, alias="from")
    reaction: str
    timestamp: int


class NextcloudTalkWorldPayload(BaseModel):
    """World/room context payload."""

    room: NextcloudTalkRoom
    bot_user_id: str | None = None
