"""Tests for plugin-zalo types module."""

from elizaos_plugin_zalo.types import (
    ZaloApiResponse,
    ZaloBotProbe,
    ZaloBotStatusPayload,
    ZaloChat,
    ZaloContent,
    ZaloEventType,
    ZaloFollowPayload,
    ZaloMessage,
    ZaloMessagePayload,
    ZaloOAInfo,
    ZaloSendImageParams,
    ZaloSendMessageParams,
    ZaloUpdate,
    ZaloUser,
    ZaloWebhookPayload,
)


class TestZaloEventType:
    """Test ZaloEventType enum."""

    def test_all_values_prefixed(self) -> None:
        for member in ZaloEventType:
            assert member.value.startswith("ZALO_")

    def test_specific_values(self) -> None:
        assert ZaloEventType.BOT_STARTED == "ZALO_BOT_STARTED"
        assert ZaloEventType.MESSAGE_RECEIVED == "ZALO_MESSAGE_RECEIVED"
        assert ZaloEventType.TOKEN_REFRESHED == "ZALO_TOKEN_REFRESHED"

    def test_count(self) -> None:
        assert len(ZaloEventType) == 8


class TestZaloUser:
    """Test ZaloUser model."""

    def test_required_fields(self) -> None:
        user = ZaloUser(id="u1")
        assert user.id == "u1"
        assert user.name is None
        assert user.avatar is None

    def test_display_name_with_name(self) -> None:
        user = ZaloUser(id="u1", name="Alice")
        assert user.display_name() == "Alice"

    def test_display_name_fallback_to_id(self) -> None:
        user = ZaloUser(id="u1")
        assert user.display_name() == "u1"


class TestZaloChat:
    """Test ZaloChat model."""

    def test_default_chat_type(self) -> None:
        chat = ZaloChat(id="c1")
        assert chat.chat_type == "PRIVATE"

    def test_explicit_chat_type(self) -> None:
        chat = ZaloChat(id="c1", chat_type="PRIVATE")
        assert chat.chat_type == "PRIVATE"


class TestZaloMessage:
    """Test ZaloMessage model."""

    def test_construction(self) -> None:
        msg = ZaloMessage(
            message_id="m1",
            **{"from": ZaloUser(id="u1")},
            chat=ZaloChat(id="c1"),
            date=1700000000,
            text="hello",
        )
        assert msg.message_id == "m1"
        assert msg.from_user.id == "u1"
        assert msg.text == "hello"

    def test_optional_fields(self) -> None:
        msg = ZaloMessage(
            message_id="m1",
            **{"from": ZaloUser(id="u1")},
            chat=ZaloChat(id="c1"),
            date=1700000000,
        )
        assert msg.text is None
        assert msg.photo is None
        assert msg.caption is None
        assert msg.sticker is None


class TestZaloOAInfo:
    """Test ZaloOAInfo model."""

    def test_required_fields(self) -> None:
        oa = ZaloOAInfo(oa_id="oa1", name="My OA")
        assert oa.oa_id == "oa1"
        assert oa.name == "My OA"

    def test_optional_fields(self) -> None:
        oa = ZaloOAInfo(oa_id="oa1", name="My OA")
        assert oa.description is None
        assert oa.avatar is None
        assert oa.cover is None


class TestZaloApiResponse:
    def test_success_response(self) -> None:
        resp = ZaloApiResponse(error=0, message="Success", data={"key": "val"})
        assert resp.error == 0
        assert resp.data is not None

    def test_error_response(self) -> None:
        resp = ZaloApiResponse(error=-1, message="Failed")
        assert resp.error == -1
        assert resp.data is None


class TestZaloSendParams:
    def test_send_message_params(self) -> None:
        p = ZaloSendMessageParams(user_id="u1", text="hello")
        assert p.user_id == "u1"
        assert p.text == "hello"

    def test_send_image_params(self) -> None:
        p = ZaloSendImageParams(user_id="u1", image_url="https://img.jpg")
        assert p.caption is None

    def test_send_image_params_with_caption(self) -> None:
        p = ZaloSendImageParams(
            user_id="u1", image_url="https://img.jpg", caption="Photo"
        )
        assert p.caption == "Photo"


class TestZaloBotProbe:
    def test_success_probe(self) -> None:
        oa = ZaloOAInfo(oa_id="oa1", name="Test")
        probe = ZaloBotProbe(ok=True, oa=oa, latency_ms=42)
        assert probe.ok is True
        assert probe.oa is not None

    def test_failure_probe(self) -> None:
        probe = ZaloBotProbe(ok=False, error="timeout", latency_ms=5000)
        assert probe.ok is False
        assert probe.error == "timeout"


class TestPayloads:
    def test_bot_status_payload(self) -> None:
        p = ZaloBotStatusPayload(update_mode="polling", timestamp=123456)
        assert p.oa_id is None
        assert p.update_mode == "polling"

    def test_webhook_payload(self) -> None:
        p = ZaloWebhookPayload(url="https://hook", path="/zalo", timestamp=100)
        assert p.port is None

    def test_message_payload(self) -> None:
        p = ZaloMessagePayload(
            message_id="m1",
            chat=ZaloChat(id="c1"),
            date=100,
        )
        assert p.from_user is None

    def test_follow_payload(self) -> None:
        p = ZaloFollowPayload(user_id="u1", action="follow", timestamp=100)
        assert p.action == "follow"


class TestZaloContent:
    def test_text_only(self) -> None:
        c = ZaloContent(text="hello")
        assert c.image_url is None

    def test_with_image(self) -> None:
        c = ZaloContent(image_url="https://img.jpg", caption="Photo")
        assert c.image_url == "https://img.jpg"
        assert c.caption == "Photo"


class TestZaloUpdate:
    def test_text_message_event(self) -> None:
        u = ZaloUpdate(event_name="message.text.received", timestamp=100)
        assert u.message is None
        assert u.user_id is None

    def test_follow_event(self) -> None:
        u = ZaloUpdate(event_name="follow", user_id="u1", timestamp=100)
        assert u.user_id == "u1"
