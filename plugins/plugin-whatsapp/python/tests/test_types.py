"""Tests for WhatsApp plugin type definitions."""

import pytest

from elizaos_plugin_whatsapp.types import (
    ContactProfile,
    IncomingMessage,
    LocationContent,
    LocationMessage,
    MediaContent,
    MediaMessage,
    MessageStatus,
    MessageType,
    ReactionContent,
    ReactionMessage,
    TemplateComponent,
    TemplateContent,
    TemplateLanguage,
    TextContent,
    TextMessage,
    WebhookChange,
    WebhookContact,
    WebhookEntry,
    WebhookMetadata,
    WebhookValue,
    WhatsAppChatState,
    WhatsAppContact,
    WhatsAppMessage,
    WhatsAppMessageId,
    WhatsAppMessageResponse,
    WhatsAppWebhookEvent,
)


class TestMessageType:
    """Tests for MessageType enum."""

    def test_text(self) -> None:
        assert MessageType.TEXT == "text"

    def test_image(self) -> None:
        assert MessageType.IMAGE == "image"

    def test_audio(self) -> None:
        assert MessageType.AUDIO == "audio"

    def test_video(self) -> None:
        assert MessageType.VIDEO == "video"

    def test_all_variants(self) -> None:
        expected = {
            "text", "image", "audio", "video", "document",
            "sticker", "location", "contacts", "template",
            "interactive", "reaction",
        }
        actual = {m.value for m in MessageType}
        assert actual == expected


class TestTextContent:
    """Tests for TextContent."""

    def test_construction(self) -> None:
        tc = TextContent(body="Hello, World!")
        assert tc.body == "Hello, World!"

    def test_empty_body(self) -> None:
        tc = TextContent(body="")
        assert tc.body == ""


class TestMediaContent:
    """Tests for MediaContent."""

    def test_with_id(self) -> None:
        mc = MediaContent(id="media-123")
        assert mc.id == "media-123"
        assert mc.link is None
        assert mc.caption is None

    def test_with_link_and_caption(self) -> None:
        mc = MediaContent(link="https://example.com/img.jpg", caption="A photo")
        assert mc.link == "https://example.com/img.jpg"
        assert mc.caption == "A photo"


class TestLocationContent:
    """Tests for LocationContent."""

    def test_construction(self) -> None:
        loc = LocationContent(latitude=37.7749, longitude=-122.4194, name="San Francisco")
        assert loc.latitude == pytest.approx(37.7749)
        assert loc.longitude == pytest.approx(-122.4194)
        assert loc.name == "San Francisco"
        assert loc.address is None


class TestReactionContent:
    """Tests for ReactionContent."""

    def test_construction(self) -> None:
        rc = ReactionContent(message_id="msg-123", emoji="👍")
        assert rc.message_id == "msg-123"
        assert rc.emoji == "👍"


class TestTemplateContent:
    """Tests for TemplateContent."""

    def test_construction(self) -> None:
        tc = TemplateContent(
            name="order_update",
            language=TemplateLanguage(code="en_US"),
            components=[
                TemplateComponent(type="body", parameters=[{"type": "text", "text": "Hello"}])
            ],
        )
        assert tc.name == "order_update"
        assert tc.language.code == "en_US"
        assert len(tc.components) == 1


class TestWhatsAppMessage:
    """Tests for WhatsAppMessage."""

    def test_text_message(self) -> None:
        msg = WhatsAppMessage(
            to="15551234567",
            type=MessageType.TEXT,
            content=TextContent(body="Hi"),
        )
        assert msg.to == "15551234567"
        assert msg.type == MessageType.TEXT


class TestWhatsAppMessageResponse:
    """Tests for WhatsAppMessageResponse."""

    def test_construction(self) -> None:
        resp = WhatsAppMessageResponse(
            messaging_product="whatsapp",
            contacts=[WhatsAppContact(input="15551234567", wa_id="15551234567")],
            messages=[WhatsAppMessageId(id="wamid.abc123")],
        )
        assert resp.messaging_product == "whatsapp"
        assert len(resp.contacts) == 1
        assert resp.contacts[0].wa_id == "15551234567"
        assert resp.messages[0].id == "wamid.abc123"

    def test_empty_responses(self) -> None:
        resp = WhatsAppMessageResponse(messaging_product="whatsapp")
        assert resp.contacts == []
        assert resp.messages == []


class TestIncomingMessage:
    """Tests for IncomingMessage."""

    def test_text_message(self) -> None:
        msg = IncomingMessage(
            **{
                "from": "15551234567",
                "id": "msg-123",
                "timestamp": "1699999999",
                "type": "text",
                "text": {"body": "Hello"},
            }
        )
        assert msg.from_ == "15551234567"
        assert msg.id == "msg-123"
        assert msg.type == "text"
        assert msg.text is not None
        assert msg.text.body == "Hello"

    def test_location_message(self) -> None:
        msg = IncomingMessage(
            **{
                "from": "15559999999",
                "id": "msg-456",
                "timestamp": "1699999999",
                "type": "location",
                "location": {"latitude": 40.7, "longitude": -74.0},
            }
        )
        assert msg.type == "location"
        assert msg.location is not None
        assert msg.location.latitude == pytest.approx(40.7)

    def test_reaction_message(self) -> None:
        msg = IncomingMessage(
            **{
                "from": "15551111111",
                "id": "msg-789",
                "timestamp": "1700000000",
                "type": "reaction",
                "reaction": {"message_id": "msg-000", "emoji": "❤️"},
            }
        )
        assert msg.reaction is not None
        assert msg.reaction.emoji == "❤️"
        assert msg.reaction.message_id == "msg-000"


class TestMessageStatus:
    """Tests for MessageStatus."""

    def test_construction(self) -> None:
        status = MessageStatus(
            id="msg-123", status="delivered", timestamp="1700000000", recipient_id="15551234567"
        )
        assert status.status == "delivered"
        assert status.recipient_id == "15551234567"


class TestWebhookEvent:
    """Tests for webhook event types."""

    def test_full_webhook_event(self) -> None:
        event = WhatsAppWebhookEvent(
            object="whatsapp_business_account",
            entry=[
                WebhookEntry(
                    id="entry-1",
                    changes=[
                        WebhookChange(
                            value=WebhookValue(
                                messaging_product="whatsapp",
                                metadata=WebhookMetadata(
                                    display_phone_number="15551234567",
                                    phone_number_id="phone-123",
                                ),
                                contacts=[
                                    WebhookContact(
                                        profile=ContactProfile(name="John Doe"),
                                        wa_id="15559999999",
                                    )
                                ],
                            ),
                            field="messages",
                        )
                    ],
                )
            ],
        )
        assert event.object == "whatsapp_business_account"
        assert len(event.entry) == 1
        change = event.entry[0].changes[0]
        assert change.field == "messages"
        assert change.value.metadata.phone_number_id == "phone-123"
        assert change.value.contacts[0].profile.name == "John Doe"


class TestWhatsAppChatState:
    """Tests for WhatsAppChatState."""

    def test_construction(self) -> None:
        state = WhatsAppChatState(
            phone_number_id="phone-123",
            contact_wa_id="15551234567",
            contact_name="Alice",
            last_message_at=1700000000,
        )
        assert state.phone_number_id == "phone-123"
        assert state.contact_wa_id == "15551234567"
        assert state.contact_name == "Alice"
        assert state.last_message_at == 1700000000

    def test_optional_fields(self) -> None:
        state = WhatsAppChatState(
            phone_number_id="phone-123",
            contact_wa_id="15551234567",
        )
        assert state.contact_name is None
        assert state.last_message_at is None
