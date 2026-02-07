"""Type definitions for the BlueBubbles plugin."""

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class DmPolicy(str, Enum):
    """DM policy options."""

    OPEN = "open"
    PAIRING = "pairing"
    ALLOWLIST = "allowlist"
    DISABLED = "disabled"


class GroupPolicy(str, Enum):
    """Group policy options."""

    OPEN = "open"
    ALLOWLIST = "allowlist"
    DISABLED = "disabled"


class BlueBubblesHandle(BaseModel):
    """BlueBubbles handle (contact)."""

    address: str
    service: str
    country: str | None = None
    original_rowid: int = Field(alias="originalROWID")
    uncanonicalized_id: str | None = Field(default=None, alias="uncanonicalizedId")

    class Config:
        populate_by_name = True


class BlueBubblesAttachment(BaseModel):
    """BlueBubbles attachment."""

    guid: str
    original_rowid: int = Field(alias="originalROWID")
    uti: str
    mime_type: str | None = Field(default=None, alias="mimeType")
    transfer_name: str = Field(alias="transferName")
    total_bytes: int = Field(alias="totalBytes")
    is_outgoing: bool = Field(alias="isOutgoing")
    hide_attachment: bool = Field(alias="hideAttachment")
    is_sticker: bool = Field(alias="isSticker")
    has_live_photo: bool = Field(alias="hasLivePhoto")
    height: int | None = None
    width: int | None = None
    metadata: dict[str, Any] | None = None

    class Config:
        populate_by_name = True


class BlueBubblesMessage(BaseModel):
    """BlueBubbles message."""

    guid: str
    text: str | None = None
    subject: str | None = None
    country: str | None = None
    handle: BlueBubblesHandle | None = None
    handle_id: int = Field(alias="handleId")
    other_handle: int = Field(alias="otherHandle")
    chats: list["BlueBubblesChat"] = []
    attachments: list[BlueBubblesAttachment] = []
    expressive_send_style_id: str | None = Field(default=None, alias="expressiveSendStyleId")
    date_created: int = Field(alias="dateCreated")
    date_read: int | None = Field(default=None, alias="dateRead")
    date_delivered: int | None = Field(default=None, alias="dateDelivered")
    is_from_me: bool = Field(alias="isFromMe")
    is_delayed: bool = Field(alias="isDelayed")
    is_auto_reply: bool = Field(alias="isAutoReply")
    is_system_message: bool = Field(alias="isSystemMessage")
    is_service_message: bool = Field(alias="isServiceMessage")
    is_forward: bool = Field(alias="isForward")
    is_archived: bool = Field(alias="isArchived")
    has_dd_results: bool = Field(alias="hasDdResults")
    has_payload_data: bool = Field(alias="hasPayloadData")
    thread_originator_guid: str | None = Field(default=None, alias="threadOriginatorGuid")
    thread_originator_part: str | None = Field(default=None, alias="threadOriginatorPart")
    associated_message_guid: str | None = Field(default=None, alias="associatedMessageGuid")
    associated_message_type: str | None = Field(default=None, alias="associatedMessageType")
    balloon_bundle_id: str | None = Field(default=None, alias="balloonBundleId")
    date_edited: int | None = Field(default=None, alias="dateEdited")
    error: int = 0
    item_type: int = Field(default=0, alias="itemType")
    group_title: str | None = Field(default=None, alias="groupTitle")
    group_action_type: int = Field(default=0, alias="groupActionType")
    payload_data: dict[str, Any] | None = Field(default=None, alias="payloadData")

    class Config:
        populate_by_name = True


class BlueBubblesChat(BaseModel):
    """BlueBubbles chat."""

    guid: str
    chat_identifier: str = Field(alias="chatIdentifier")
    display_name: str | None = Field(default=None, alias="displayName")
    participants: list[BlueBubblesHandle] = []
    last_message: BlueBubblesMessage | None = Field(default=None, alias="lastMessage")
    style: int = 0
    is_archived: bool = Field(default=False, alias="isArchived")
    is_filtered: bool = Field(default=False, alias="isFiltered")
    is_pinned: bool = Field(default=False, alias="isPinned")
    has_unread_messages: bool = Field(default=False, alias="hasUnreadMessages")

    class Config:
        populate_by_name = True


# Update forward reference
BlueBubblesMessage.model_rebuild()


class BlueBubblesServerInfo(BaseModel):
    """BlueBubbles server info."""

    os_version: str
    server_version: str
    private_api: bool
    proxy_service: str | None = None
    helper_connected: bool
    detected_icloud: str | None = None


class SendMessageOptions(BaseModel):
    """Options for sending a message."""

    temp_guid: str | None = None
    method: str | None = "apple-script"
    subject: str | None = None
    effect_id: str | None = None
    part_index: int | None = None
    dd_scan: bool | None = None


class SendMessageResult(BaseModel):
    """Result of sending a message."""

    guid: str
    temp_guid: str | None = None
    status: str = "sent"
    date_created: int
    text: str
    error: str | None = None


class BlueBubblesProbeResult(BaseModel):
    """Result of probing the BlueBubbles server."""

    ok: bool
    server_version: str | None = None
    os_version: str | None = None
    private_api_enabled: bool | None = None
    helper_connected: bool | None = None
    error: str | None = None


class BlueBubblesChatState(BaseModel):
    """State information for a BlueBubbles chat."""

    chat_guid: str
    chat_identifier: str
    is_group: bool
    participants: list[str]
    display_name: str | None = None
    last_message_at: int | None = None
    has_unread: bool = False


class BlueBubblesWebhookPayload(BaseModel):
    """Webhook payload from BlueBubbles."""

    type: str
    data: dict[str, Any]
