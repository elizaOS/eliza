"""Tests for plugin-zalouser types module."""

from elizaos_plugin_zalouser.types import (
    SendMediaParams,
    SendMessageParams,
    SendMessageResult,
    ZaloChat,
    ZaloFriend,
    ZaloGroup,
    ZaloMessage,
    ZaloMessageMetadata,
    ZaloMessagePayload,
    ZaloUser,
    ZaloUserChatType,
    ZaloUserClientStatus,
    ZaloUserEventType,
    ZaloUserInfo,
    ZaloUserProbe,
    ZaloUserProfile,
    ZaloUserQrCodePayload,
    ZaloWorldPayload,
)


class TestZaloUserEventType:
    def test_all_prefixed(self) -> None:
        for member in ZaloUserEventType:
            assert member.value.startswith("ZALOUSER_")

    def test_count(self) -> None:
        assert len(ZaloUserEventType) == 15

    def test_specific_values(self) -> None:
        assert ZaloUserEventType.MESSAGE_RECEIVED == "ZALOUSER_MESSAGE_RECEIVED"
        assert ZaloUserEventType.QR_CODE_READY == "ZALOUSER_QR_CODE_READY"
        assert ZaloUserEventType.CLIENT_STARTED == "ZALOUSER_CLIENT_STARTED"


class TestZaloUserChatType:
    def test_private(self) -> None:
        assert ZaloUserChatType.PRIVATE == "private"

    def test_group(self) -> None:
        assert ZaloUserChatType.GROUP == "group"


class TestZaloUser:
    def test_required_fields(self) -> None:
        u = ZaloUser(id="u1", displayName="Alice")
        assert u.id == "u1"
        assert u.display_name == "Alice"

    def test_optional_fields(self) -> None:
        u = ZaloUser(id="u1", displayName="Alice")
        assert u.username is None
        assert u.avatar is None
        assert u.is_self is False

    def test_is_self_flag(self) -> None:
        u = ZaloUser(id="u1", displayName="Me", isSelf=True)
        assert u.is_self is True


class TestZaloChat:
    def test_private_chat(self) -> None:
        c = ZaloChat(threadId="t1", type=ZaloUserChatType.PRIVATE, isGroup=False)
        assert c.thread_id == "t1"
        assert c.is_group is False

    def test_group_chat(self) -> None:
        c = ZaloChat(
            threadId="t2",
            type=ZaloUserChatType.GROUP,
            name="Group",
            memberCount=5,
            isGroup=True,
        )
        assert c.is_group is True
        assert c.member_count == 5


class TestZaloFriend:
    def test_construction(self) -> None:
        f = ZaloFriend(userId="f1", displayName="Bob")
        assert f.user_id == "f1"
        assert f.display_name == "Bob"
        assert f.phone_number is None

    def test_with_phone(self) -> None:
        f = ZaloFriend(userId="f1", displayName="Bob", phoneNumber="09123456")
        assert f.phone_number == "09123456"


class TestZaloGroup:
    def test_construction(self) -> None:
        g = ZaloGroup(groupId="g1", name="Group A")
        assert g.group_id == "g1"
        assert g.name == "Group A"
        assert g.member_count is None

    def test_with_member_count(self) -> None:
        g = ZaloGroup(groupId="g1", name="Group A", memberCount=42)
        assert g.member_count == 42


class TestZaloMessage:
    def test_construction(self) -> None:
        m = ZaloMessage(threadId="t1", type=0, content="Hello", timestamp=100)
        assert m.thread_id == "t1"
        assert m.content == "Hello"

    def test_optional_metadata(self) -> None:
        m = ZaloMessage(threadId="t1", type=0, content="Hi", timestamp=100)
        assert m.metadata is None
        assert m.msg_id is None
        assert m.cli_msg_id is None

    def test_with_metadata(self) -> None:
        meta = ZaloMessageMetadata(isGroup=True, senderName="Alice")
        m = ZaloMessage(
            threadId="t1", type=0, content="Hi", timestamp=100, metadata=meta
        )
        assert m.metadata is not None
        assert m.metadata.is_group is True
        assert m.metadata.sender_name == "Alice"


class TestZaloUserInfo:
    def test_construction(self) -> None:
        info = ZaloUserInfo(userId="u1", displayName="Alice")
        assert info.user_id == "u1"
        assert info.display_name == "Alice"
        assert info.avatar is None
        assert info.phone_number is None


class TestZaloUserProbe:
    def test_success(self) -> None:
        user = ZaloUser(id="u1", displayName="Alice")
        probe = ZaloUserProbe(ok=True, user=user, latency_ms=42)
        assert probe.ok is True
        assert probe.user is not None

    def test_failure(self) -> None:
        probe = ZaloUserProbe(ok=False, error="timeout", latency_ms=5000)
        assert probe.ok is False
        assert probe.error == "timeout"


class TestZaloUserClientStatus:
    def test_construction(self) -> None:
        s = ZaloUserClientStatus(running=True, timestamp=100)
        assert s.running is True
        assert s.profile is None


class TestZaloUserQrCodePayload:
    def test_construction(self) -> None:
        p = ZaloUserQrCodePayload(message="Scan QR")
        assert p.message == "Scan QR"
        assert p.qr_data_url is None
        assert p.profile is None


class TestSendMessageParams:
    def test_construction(self) -> None:
        p = SendMessageParams(threadId="t1", text="Hello")
        assert p.thread_id == "t1"
        assert p.text == "Hello"
        assert p.is_group is False

    def test_group_message(self) -> None:
        p = SendMessageParams(threadId="t1", text="Hello", isGroup=True)
        assert p.is_group is True


class TestSendMessageResult:
    def test_success(self) -> None:
        r = SendMessageResult(success=True, threadId="t1", messageId="m1")
        assert r.success is True
        assert r.message_id == "m1"

    def test_failure(self) -> None:
        r = SendMessageResult(success=False, threadId="t1", error="timeout")
        assert r.error == "timeout"


class TestSendMediaParams:
    def test_construction(self) -> None:
        p = SendMediaParams(threadId="t1", mediaUrl="https://img.jpg")
        assert p.media_url == "https://img.jpg"
        assert p.caption is None
        assert p.is_group is False


class TestZaloUserProfile:
    def test_construction(self) -> None:
        p = ZaloUserProfile(name="default")
        assert p.name == "default"
        assert p.is_default is False
        assert p.cookie_path is None


class TestZaloMessagePayload:
    def test_construction(self) -> None:
        msg = ZaloMessage(threadId="t1", type=0, content="Hi", timestamp=100)
        chat = ZaloChat(threadId="t1", type=ZaloUserChatType.PRIVATE, isGroup=False)
        p = ZaloMessagePayload(message=msg, chat=chat)
        assert p.sender is None


class TestZaloWorldPayload:
    def test_construction(self) -> None:
        chat = ZaloChat(threadId="t1", type=ZaloUserChatType.GROUP, isGroup=True)
        p = ZaloWorldPayload(chat=chat)
        assert p.current_user is None
