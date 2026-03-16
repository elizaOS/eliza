"""Serializable types used for events and payloads."""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MSTeamsEventType(str, Enum):
    """Event types emitted by the MS Teams plugin."""

    WORLD_JOINED = "MSTEAMS_WORLD_JOINED"
    WORLD_CONNECTED = "MSTEAMS_WORLD_CONNECTED"
    WORLD_LEFT = "MSTEAMS_WORLD_LEFT"
    ENTITY_JOINED = "MSTEAMS_ENTITY_JOINED"
    ENTITY_LEFT = "MSTEAMS_ENTITY_LEFT"
    ENTITY_UPDATED = "MSTEAMS_ENTITY_UPDATED"
    MESSAGE_RECEIVED = "MSTEAMS_MESSAGE_RECEIVED"
    MESSAGE_SENT = "MSTEAMS_MESSAGE_SENT"
    REACTION_RECEIVED = "MSTEAMS_REACTION_RECEIVED"
    CARD_ACTION_RECEIVED = "MSTEAMS_CARD_ACTION_RECEIVED"
    FILE_CONSENT_RECEIVED = "MSTEAMS_FILE_CONSENT_RECEIVED"


class ConversationType(str, Enum):
    """MS Teams conversation type."""

    PERSONAL = "personal"
    GROUP_CHAT = "groupChat"
    CHANNEL = "channel"


class MSTeamsUser(BaseModel):
    """MS Teams user information."""

    id: str
    name: str | None = None
    aad_object_id: str | None = Field(default=None, alias="aadObjectId")
    email: str | None = None
    user_principal_name: str | None = Field(default=None, alias="userPrincipalName")

    model_config = ConfigDict(populate_by_name=True)

    def display_name(self) -> str:
        """Returns a human-friendly display name for the user."""
        return (
            self.name
            or self.user_principal_name
            or self.email
            or self.id
        )


class MSTeamsConversation(BaseModel):
    """MS Teams conversation information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    conversation_type: ConversationType | None = Field(default=None, alias="conversationType")
    tenant_id: str | None = Field(default=None, alias="tenantId")
    name: str | None = None
    is_group: bool | None = Field(default=None, alias="isGroup")


class MSTeamsChannel(BaseModel):
    """MS Teams channel information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str | None = None
    tenant_id: str | None = Field(default=None, alias="tenantId")


class MSTeamsTeam(BaseModel):
    """MS Teams team information."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str | None = None
    aad_group_id: str | None = Field(default=None, alias="aadGroupId")


class MSTeamsConversationReference(BaseModel):
    """Stored conversation reference for proactive messaging."""

    model_config = ConfigDict(populate_by_name=True)

    activity_id: str | None = Field(default=None, alias="activityId")
    user: MSTeamsUser | None = None
    bot: MSTeamsUser | None = None
    conversation: MSTeamsConversation
    channel_id: str = Field(default="msteams", alias="channelId")
    service_url: str | None = Field(default=None, alias="serviceUrl")
    locale: str | None = None


class MSTeamsMention(BaseModel):
    """MS Teams mention."""

    mentioned: MSTeamsUser
    text: str


class MSTeamsAttachment(BaseModel):
    """MS Teams attachment."""

    model_config = ConfigDict(populate_by_name=True)

    content_type: str = Field(alias="contentType")
    content_url: str | None = Field(default=None, alias="contentUrl")
    content: dict | None = None
    name: str | None = None
    thumbnail_url: str | None = Field(default=None, alias="thumbnailUrl")


class MSTeamsContent(BaseModel):
    """MS Teams message content extension."""

    text: str | None = None
    adaptive_card: dict | None = Field(default=None, alias="adaptiveCard")
    mentions: list[MSTeamsMention] = Field(default_factory=list)
    attachments: list[MSTeamsAttachment] = Field(default_factory=list)


class MSTeamsPoll(BaseModel):
    """MS Teams poll definition."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    question: str
    options: list[str]
    max_selections: int = Field(default=1, alias="maxSelections")
    created_at: str = Field(alias="createdAt")
    updated_at: str | None = Field(default=None, alias="updatedAt")
    conversation_id: str | None = Field(default=None, alias="conversationId")
    message_id: str | None = Field(default=None, alias="messageId")
    votes: dict[str, list[str]] = Field(default_factory=dict)


class MSTeamsPollVote(BaseModel):
    """MS Teams poll vote."""

    model_config = ConfigDict(populate_by_name=True)

    poll_id: str = Field(alias="pollId")
    voter_id: str = Field(alias="voterId")
    selections: list[str]


class MSTeamsMessagePayload(BaseModel):
    """Payload for a received message event."""

    model_config = ConfigDict(populate_by_name=True)

    activity_id: str = Field(alias="activityId")
    conversation_id: str = Field(alias="conversationId")
    conversation_type: ConversationType = Field(alias="conversationType")
    from_user: MSTeamsUser = Field(alias="from")
    conversation: MSTeamsConversation
    service_url: str = Field(alias="serviceUrl")
    text: str | None = None
    timestamp: int
    reply_to_id: str | None = Field(default=None, alias="replyToId")
    channel_data: dict | None = Field(default=None, alias="channelData")


class MSTeamsReactionPayload(BaseModel):
    """Payload for a reaction event."""

    model_config = ConfigDict(populate_by_name=True)

    activity_id: str = Field(alias="activityId")
    conversation_id: str = Field(alias="conversationId")
    from_user: MSTeamsUser = Field(alias="from")
    reaction_type: str = Field(alias="reactionType")
    message_id: str = Field(alias="messageId")


class MSTeamsCardActionPayload(BaseModel):
    """Payload for a card action event."""

    model_config = ConfigDict(populate_by_name=True)

    activity_id: str = Field(alias="activityId")
    conversation_id: str = Field(alias="conversationId")
    from_user: MSTeamsUser = Field(alias="from")
    value: dict


class MSTeamsSendResult(BaseModel):
    """MS Teams send message result."""

    model_config = ConfigDict(populate_by_name=True)

    message_id: str = Field(alias="messageId")
    conversation_id: str = Field(alias="conversationId")
    activity_id: str | None = Field(default=None, alias="activityId")


class MSTeamsSendOptions(BaseModel):
    """MS Teams send message options."""

    model_config = ConfigDict(populate_by_name=True)

    reply_to_id: str | None = Field(default=None, alias="replyToId")
    thread_id: str | None = Field(default=None, alias="threadId")
    adaptive_card: dict | None = Field(default=None, alias="adaptiveCard")
    mentions: list[MSTeamsMention] = Field(default_factory=list)
    media_urls: list[str] = Field(default_factory=list, alias="mediaUrls")


class MSTeamsWorldPayload(BaseModel):
    """Payload for world-related events."""

    team: MSTeamsTeam | None = None
    channel: MSTeamsChannel | None = None
    tenant_id: str | None = Field(default=None, alias="tenantId")


class MSTeamsEntityPayload(BaseModel):
    """Payload for entity-related events."""

    user: MSTeamsUser
    action: Literal["added", "removed", "updated"]
    conversation_id: str | None = Field(default=None, alias="conversationId")
