"""Tests for Tlon plugin types."""

from __future__ import annotations

from elizaos_plugin_tlon.types import (
    TlonChannelType,
    TlonChat,
    TlonContent,
    TlonEntityPayload,
    TlonEventType,
    TlonMemo,
    TlonMessagePayload,
    TlonMessageSentPayload,
    TlonShip,
    TlonWorldPayload,
)


# ---------------------------------------------------------------------------
# TlonEventType
# ---------------------------------------------------------------------------
class TestTlonEventType:
    """Tests for the TlonEventType enum."""

    def test_all_values_prefixed_with_tlon(self) -> None:
        for member in TlonEventType:
            assert member.value.startswith("TLON_"), f"{member} does not start with TLON_"

    def test_has_11_members(self) -> None:
        assert len(TlonEventType) == 11

    def test_message_event_values(self) -> None:
        assert TlonEventType.MESSAGE_RECEIVED.value == "TLON_MESSAGE_RECEIVED"
        assert TlonEventType.MESSAGE_SENT.value == "TLON_MESSAGE_SENT"
        assert TlonEventType.DM_RECEIVED.value == "TLON_DM_RECEIVED"
        assert TlonEventType.GROUP_MESSAGE_RECEIVED.value == "TLON_GROUP_MESSAGE_RECEIVED"

    def test_world_event_values(self) -> None:
        assert TlonEventType.WORLD_JOINED.value == "TLON_WORLD_JOINED"
        assert TlonEventType.WORLD_CONNECTED.value == "TLON_WORLD_CONNECTED"
        assert TlonEventType.WORLD_LEFT.value == "TLON_WORLD_LEFT"

    def test_entity_event_values(self) -> None:
        assert TlonEventType.ENTITY_JOINED.value == "TLON_ENTITY_JOINED"
        assert TlonEventType.ENTITY_LEFT.value == "TLON_ENTITY_LEFT"

    def test_connection_event_values(self) -> None:
        assert TlonEventType.CONNECTION_ERROR.value == "TLON_CONNECTION_ERROR"
        assert TlonEventType.RECONNECTED.value == "TLON_RECONNECTED"

    def test_is_string_enum(self) -> None:
        assert isinstance(TlonEventType.DM_RECEIVED, str)
        assert TlonEventType.DM_RECEIVED == "TLON_DM_RECEIVED"


# ---------------------------------------------------------------------------
# TlonChannelType
# ---------------------------------------------------------------------------
class TestTlonChannelType:
    """Tests for the TlonChannelType enum."""

    def test_has_3_members(self) -> None:
        assert len(TlonChannelType) == 3

    def test_values(self) -> None:
        assert TlonChannelType.DM.value == "dm"
        assert TlonChannelType.GROUP.value == "group"
        assert TlonChannelType.THREAD.value == "thread"

    def test_is_string_enum(self) -> None:
        assert isinstance(TlonChannelType.DM, str)
        assert TlonChannelType.DM == "dm"


# ---------------------------------------------------------------------------
# TlonShip
# ---------------------------------------------------------------------------
class TestTlonShip:
    """Tests for the TlonShip pydantic model."""

    def test_creation_with_name_only(self) -> None:
        ship = TlonShip(name="sampel-palnet")
        assert ship.name == "sampel-palnet"
        assert ship.display_name is None
        assert ship.avatar is None

    def test_creation_with_all_fields(self) -> None:
        ship = TlonShip(
            name="sampel-palnet",
            display_name="Sampel",
            avatar="https://img.com/avatar.png",
        )
        assert ship.display_name == "Sampel"
        assert ship.avatar == "https://img.com/avatar.png"

    def test_formatted_adds_tilde(self) -> None:
        ship = TlonShip(name="sampel-palnet")
        assert ship.formatted() == "~sampel-palnet"

    def test_serialization_roundtrip(self) -> None:
        original = TlonShip(name="zod", display_name="Zod")
        data = original.model_dump()
        restored = TlonShip(**data)
        assert restored.name == "zod"
        assert restored.display_name == "Zod"


# ---------------------------------------------------------------------------
# TlonChat
# ---------------------------------------------------------------------------
class TestTlonChat:
    """Tests for the TlonChat pydantic model."""

    def test_dm_factory(self) -> None:
        chat = TlonChat.dm("sampel-palnet")
        assert chat.id == "sampel-palnet"
        assert chat.type == TlonChannelType.DM
        assert chat.name == "DM with ~sampel-palnet"
        assert chat.host_ship is None
        assert chat.description is None

    def test_group_factory(self) -> None:
        chat = TlonChat.group(
            "chat/~host/general",
            name="general",
            host_ship="host-ship",
        )
        assert chat.id == "chat/~host/general"
        assert chat.type == TlonChannelType.GROUP
        assert chat.name == "general"
        assert chat.host_ship == "host-ship"

    def test_group_factory_minimal(self) -> None:
        chat = TlonChat.group("chat/~host/ch")
        assert chat.name is None
        assert chat.host_ship is None

    def test_manual_thread_creation(self) -> None:
        chat = TlonChat(
            id="chat/~host/channel",
            type=TlonChannelType.THREAD,
            name="channel",
            host_ship="host",
        )
        assert chat.type == TlonChannelType.THREAD

    def test_serialization_roundtrip(self) -> None:
        original = TlonChat.dm("zod")
        data = original.model_dump()
        restored = TlonChat(**data)
        assert restored.id == "zod"
        assert restored.type == TlonChannelType.DM


# ---------------------------------------------------------------------------
# TlonMessagePayload
# ---------------------------------------------------------------------------
class TestTlonMessagePayload:
    """Tests for the TlonMessagePayload model."""

    def test_creation_with_required_fields(self) -> None:
        payload = TlonMessagePayload(
            message_id="msg-001",
            chat=TlonChat.dm("zod"),
            from_ship=TlonShip(name="zod"),
            text="Hello",
            timestamp=1700000000000,
        )
        assert payload.message_id == "msg-001"
        assert payload.text == "Hello"
        assert payload.reply_to_id is None
        assert payload.raw_content is None

    def test_creation_with_optional_fields(self) -> None:
        payload = TlonMessagePayload(
            message_id="msg-002",
            chat=TlonChat.group("chat/~host/ch", name="ch"),
            from_ship=TlonShip(name="sender"),
            text="Thread reply",
            timestamp=1700000000000,
            reply_to_id="parent-id",
            raw_content=[{"inline": ["Thread reply"]}],
        )
        assert payload.reply_to_id == "parent-id"
        assert payload.raw_content == [{"inline": ["Thread reply"]}]

    def test_serialization_roundtrip(self) -> None:
        original = TlonMessagePayload(
            message_id="msg-rt",
            chat=TlonChat.dm("zod"),
            from_ship=TlonShip(name="zod"),
            text="Roundtrip",
            timestamp=12345,
        )
        data = original.model_dump()
        restored = TlonMessagePayload(**data)
        assert restored.message_id == "msg-rt"
        assert restored.chat.type == TlonChannelType.DM


# ---------------------------------------------------------------------------
# TlonMessageSentPayload
# ---------------------------------------------------------------------------
class TestTlonMessageSentPayload:
    """Tests for the TlonMessageSentPayload model."""

    def test_default_is_reply_false(self) -> None:
        payload = TlonMessageSentPayload(
            message_id="sent-001",
            chat=TlonChat.dm("zod"),
            text="Sent message",
        )
        assert payload.is_reply is False

    def test_is_reply_true(self) -> None:
        payload = TlonMessageSentPayload(
            message_id="sent-002",
            chat=TlonChat.group("chat/~h/c"),
            text="Reply",
            is_reply=True,
        )
        assert payload.is_reply is True


# ---------------------------------------------------------------------------
# TlonWorldPayload
# ---------------------------------------------------------------------------
class TestTlonWorldPayload:
    """Tests for the TlonWorldPayload model."""

    def test_defaults_are_empty_lists(self) -> None:
        payload = TlonWorldPayload(ship=TlonShip(name="zod"))
        assert payload.dm_conversations == []
        assert payload.group_channels == []

    def test_with_conversations(self) -> None:
        payload = TlonWorldPayload(
            ship=TlonShip(name="zod"),
            dm_conversations=["ship-a", "ship-b"],
            group_channels=["chat/~h/c"],
        )
        assert len(payload.dm_conversations) == 2
        assert len(payload.group_channels) == 1


# ---------------------------------------------------------------------------
# TlonEntityPayload
# ---------------------------------------------------------------------------
class TestTlonEntityPayload:
    """Tests for the TlonEntityPayload model."""

    def test_joined_action(self) -> None:
        payload = TlonEntityPayload(
            ship=TlonShip(name="zod"),
            chat=TlonChat.dm("zod"),
            action="joined",
        )
        assert payload.action == "joined"

    def test_left_action(self) -> None:
        payload = TlonEntityPayload(
            ship=TlonShip(name="zod"),
            chat=TlonChat.dm("zod"),
            action="left",
        )
        assert payload.action == "left"

    def test_updated_action(self) -> None:
        payload = TlonEntityPayload(
            ship=TlonShip(name="zod"),
            chat=TlonChat.dm("zod"),
            action="updated",
        )
        assert payload.action == "updated"


# ---------------------------------------------------------------------------
# TlonContent
# ---------------------------------------------------------------------------
class TestTlonContent:
    """Tests for the TlonContent model."""

    def test_all_fields_optional(self) -> None:
        content = TlonContent()
        assert content.text is None
        assert content.ship is None
        assert content.channel_nest is None
        assert content.reply_to_id is None

    def test_full_content(self) -> None:
        content = TlonContent(
            text="Hello",
            ship="sampel-palnet",
            channel_nest="chat/~host/ch",
            reply_to_id="parent",
        )
        assert content.text == "Hello"
        assert content.ship == "sampel-palnet"
        assert content.channel_nest == "chat/~host/ch"
        assert content.reply_to_id == "parent"


# ---------------------------------------------------------------------------
# TlonMemo
# ---------------------------------------------------------------------------
class TestTlonMemo:
    """Tests for the TlonMemo model."""

    def test_creation(self) -> None:
        memo = TlonMemo(
            content=[{"inline": ["Hello"]}],
            author="~sampel-palnet",
            sent=1700000000000,
        )
        assert memo.author == "~sampel-palnet"
        assert memo.sent == 1700000000000
        assert len(memo.content) == 1
        assert memo.content[0]["inline"] == ["Hello"]

    def test_serialization_roundtrip(self) -> None:
        original = TlonMemo(
            content=[{"inline": ["Test"]}],
            author="~zod",
            sent=123,
        )
        data = original.model_dump()
        restored = TlonMemo(**data)
        assert restored.author == "~zod"
        assert restored.content == original.content
