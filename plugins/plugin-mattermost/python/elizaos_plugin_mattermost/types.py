from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class MattermostEventType(str, Enum):
    """Event types emitted by the Mattermost plugin."""

    WORLD_JOINED = "MATTERMOST_WORLD_JOINED"
    WORLD_CONNECTED = "MATTERMOST_WORLD_CONNECTED"
    WORLD_LEFT = "MATTERMOST_WORLD_LEFT"
    ENTITY_JOINED = "MATTERMOST_ENTITY_JOINED"
    ENTITY_LEFT = "MATTERMOST_ENTITY_LEFT"
    ENTITY_UPDATED = "MATTERMOST_ENTITY_UPDATED"
    MESSAGE_RECEIVED = "MATTERMOST_MESSAGE_RECEIVED"
    MESSAGE_SENT = "MATTERMOST_MESSAGE_SENT"
    REACTION_RECEIVED = "MATTERMOST_REACTION_RECEIVED"
    INTERACTION_RECEIVED = "MATTERMOST_INTERACTION_RECEIVED"


class MattermostChannelType(str, Enum):
    """Mattermost channel types."""

    DIRECT = "D"
    GROUP = "G"
    OPEN = "O"
    PRIVATE = "P"


class DmPolicy(str, Enum):
    """DM policy options."""

    PAIRING = "pairing"
    ALLOWLIST = "allowlist"
    OPEN = "open"
    DISABLED = "disabled"


class GroupPolicy(str, Enum):
    """Group policy options."""

    ALLOWLIST = "allowlist"
    OPEN = "open"
    DISABLED = "disabled"


class MattermostUser(BaseModel):
    """Mattermost user information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    username: str | None = None
    nickname: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None
    position: str | None = None
    roles: str | None = None
    is_bot: bool = False
    bot_description: str | None = None
    create_at: int | None = None
    update_at: int | None = None
    delete_at: int | None = None

    def display_name(self) -> str:
        """Returns a human-friendly display name for the user."""
        if self.nickname and self.nickname.strip():
            return self.nickname.strip()
        if self.first_name or self.last_name:
            parts = [
                self.first_name.strip() if self.first_name else "",
                self.last_name.strip() if self.last_name else "",
            ]
            name = " ".join(p for p in parts if p)
            if name:
                return name
        if self.username and self.username.strip():
            return self.username.strip()
        return self.id


class MattermostChannel(BaseModel):
    """Mattermost channel information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str | None = None
    display_name: str | None = None
    type: str | None = Field(default=None, alias="type")
    team_id: str | None = None
    header: str | None = None
    purpose: str | None = None
    creator_id: str | None = None
    create_at: int | None = None
    update_at: int | None = None
    delete_at: int | None = None

    def display_name_str(self) -> str:
        """Returns a human-friendly display name for the channel."""
        if self.display_name and self.display_name.strip():
            return self.display_name.strip()
        if self.name and self.name.strip():
            return self.name.strip()
        return self.id

    def get_channel_type(self) -> MattermostChannelType | None:
        """Returns the channel type enum."""
        if not self.type:
            return None
        type_upper = self.type.strip().upper()
        for ct in MattermostChannelType:
            if ct.value == type_upper:
                return ct
        return None

    def kind(self) -> Literal["dm", "group", "channel"]:
        """Returns the channel kind."""
        ct = self.get_channel_type()
        if ct == MattermostChannelType.DIRECT:
            return "dm"
        if ct == MattermostChannelType.GROUP:
            return "group"
        return "channel"


class MattermostPost(BaseModel):
    """Mattermost post (message) information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    user_id: str | None = None
    channel_id: str | None = None
    message: str | None = None
    file_ids: list[str] | None = None
    type: str | None = Field(default=None, alias="type")
    root_id: str | None = None
    parent_id: str | None = None
    create_at: int | None = None
    update_at: int | None = None
    delete_at: int | None = None
    edit_at: int | None = None
    props: dict[str, Any] | None = None
    hashtags: str | None = None

    def is_system_post(self) -> bool:
        """Returns True if this is a system post."""
        return bool(self.type and self.type.strip())

    def message_text(self) -> str:
        """Returns the trimmed message content."""
        return (self.message or "").strip()


class MattermostFileInfo(BaseModel):
    """Mattermost file information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str | None = None
    mime_type: str | None = None
    size: int | None = None
    extension: str | None = None
    post_id: str | None = None
    channel_id: str | None = None
    create_at: int | None = None


class MattermostTeam(BaseModel):
    """Mattermost team information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    type: str | None = Field(default=None, alias="type")
    create_at: int | None = None
    update_at: int | None = None
    delete_at: int | None = None


class MattermostContent(BaseModel):
    """Mattermost content with optional attachments."""

    text: str | None = None
    file_ids: list[str] | None = None
    root_id: str | None = None
    props: dict[str, Any] | None = None


class MattermostMessagePayload(BaseModel):
    """Payload for a received message event."""

    model_config = ConfigDict(populate_by_name=True)

    post: MattermostPost
    channel: MattermostChannel
    user: MattermostUser | None = Field(default=None, alias="from")
    team: MattermostTeam | None = None


class MattermostReactionPayload(BaseModel):
    """Payload for a reaction event."""

    model_config = ConfigDict(populate_by_name=True)

    post_id: str
    user: MattermostUser | None = None
    emoji_name: str
    create_at: int | None = None


class MattermostWorldPayload(BaseModel):
    """Payload for world/channel events."""

    channel: MattermostChannel
    team: MattermostTeam | None = None
    bot_username: str | None = None


class MattermostEntityPayload(BaseModel):
    """Payload for entity (user) events."""

    user: MattermostUser
    channel: MattermostChannel
    action: Literal["joined", "left", "updated"]


def get_channel_kind(channel_type: str | None) -> Literal["dm", "group", "channel"]:
    """Returns the channel kind from type string."""
    if not channel_type:
        return "channel"
    normalized = channel_type.strip().upper()
    if normalized == "D":
        return "dm"
    if normalized == "G":
        return "group"
    return "channel"
