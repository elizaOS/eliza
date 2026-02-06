"""Type definitions for the WhatsApp plugin."""

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class MessageType(str, Enum):
    """WhatsApp message types."""

    TEXT = "text"
    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    DOCUMENT = "document"
    STICKER = "sticker"
    LOCATION = "location"
    CONTACTS = "contacts"
    TEMPLATE = "template"
    INTERACTIVE = "interactive"
    REACTION = "reaction"


class TextContent(BaseModel):
    """Text message content."""

    body: str


class MediaContent(BaseModel):
    """Media message content."""

    id: str | None = None
    link: str | None = None
    caption: str | None = None


class TemplateLanguage(BaseModel):
    """Template language."""

    code: str


class TemplateComponent(BaseModel):
    """Template component."""

    type: str
    parameters: list[dict[str, Any]] = []


class TemplateContent(BaseModel):
    """Template message content."""

    name: str
    language: TemplateLanguage
    components: list[TemplateComponent] = []


class LocationContent(BaseModel):
    """Location message content."""

    latitude: float
    longitude: float
    name: str | None = None
    address: str | None = None


class ReactionContent(BaseModel):
    """Reaction message content."""

    message_id: str
    emoji: str


MessageContent = TextContent | MediaContent | TemplateContent | LocationContent | ReactionContent


class WhatsAppMessage(BaseModel):
    """WhatsApp message to send."""

    to: str
    type: MessageType
    content: MessageContent


class WhatsAppContact(BaseModel):
    """Contact in response."""

    input: str
    wa_id: str


class WhatsAppMessageId(BaseModel):
    """Message ID in response."""

    id: str


class WhatsAppMessageResponse(BaseModel):
    """Message send response."""

    messaging_product: str
    contacts: list[WhatsAppContact] = []
    messages: list[WhatsAppMessageId] = []


class ContactProfile(BaseModel):
    """Contact profile."""

    name: str


class WebhookContact(BaseModel):
    """Webhook contact."""

    profile: ContactProfile
    wa_id: str


class TextMessage(BaseModel):
    """Text message."""

    body: str


class MediaMessage(BaseModel):
    """Media message."""

    id: str
    mime_type: str | None = None
    sha256: str | None = None
    caption: str | None = None


class LocationMessage(BaseModel):
    """Location message."""

    latitude: float
    longitude: float
    name: str | None = None
    address: str | None = None


class ReactionMessage(BaseModel):
    """Reaction message."""

    message_id: str
    emoji: str


class IncomingMessage(BaseModel):
    """Incoming message."""

    from_: str = Field(alias="from")
    id: str
    timestamp: str
    type: str
    text: TextMessage | None = None
    image: MediaMessage | None = None
    audio: MediaMessage | None = None
    video: MediaMessage | None = None
    document: MediaMessage | None = None
    sticker: MediaMessage | None = None
    location: LocationMessage | None = None
    reaction: ReactionMessage | None = None

    class Config:
        populate_by_name = True


class MessageStatus(BaseModel):
    """Message status."""

    id: str
    status: str
    timestamp: str
    recipient_id: str


class WebhookMetadata(BaseModel):
    """Webhook metadata."""

    display_phone_number: str
    phone_number_id: str


class WebhookValue(BaseModel):
    """Webhook value."""

    messaging_product: str
    metadata: WebhookMetadata
    contacts: list[WebhookContact] | None = None
    messages: list[IncomingMessage] | None = None
    statuses: list[MessageStatus] | None = None


class WebhookChange(BaseModel):
    """Webhook change."""

    value: WebhookValue
    field: str


class WebhookEntry(BaseModel):
    """Webhook entry."""

    id: str
    changes: list[WebhookChange]


class WhatsAppWebhookEvent(BaseModel):
    """Webhook event."""

    object: str
    entry: list[WebhookEntry]


class WhatsAppChatState(BaseModel):
    """Chat state for provider."""

    phone_number_id: str
    contact_wa_id: str
    contact_name: str | None = None
    last_message_at: int | None = None
