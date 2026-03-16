"""Tests for Tlon plugin providers."""

from __future__ import annotations

from elizaos_plugin_tlon.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_tlon.types import TlonChannelType


# ---------------------------------------------------------------------------
# CHAT_STATE_PROVIDER metadata
# ---------------------------------------------------------------------------
class TestChatStateProviderMetadata:
    """Tests for the CHAT_STATE_PROVIDER dict."""

    def test_name_is_tlon_chat_state(self) -> None:
        assert CHAT_STATE_PROVIDER["name"] == "tlon_chat_state"

    def test_description_mentions_tlon(self) -> None:
        assert "tlon" in CHAT_STATE_PROVIDER["description"].lower()

    def test_is_dynamic(self) -> None:
        assert CHAT_STATE_PROVIDER["dynamic"] is True


# ---------------------------------------------------------------------------
# ChatStateResult dataclass
# ---------------------------------------------------------------------------
class TestChatStateResult:
    """Tests for the ChatStateResult dataclass."""

    def test_default_values_and_text(self) -> None:
        result = ChatStateResult(data={"key": "val"})
        assert result.data == {"key": "val"}
        assert result.values == {}
        assert result.text == ""


# ---------------------------------------------------------------------------
# get_chat_state
# ---------------------------------------------------------------------------
class TestGetChatState:
    """Tests for the get_chat_state function."""

    def test_dm_state_with_ship_only(self) -> None:
        result = get_chat_state(ship="sampel-palnet")
        assert result.data["chat_type"] == TlonChannelType.DM.value
        assert result.data["is_dm"] is True
        assert result.data["is_group"] is False
        assert result.data["is_thread"] is False
        assert result.data["ship"] == "sampel-palnet"

    def test_group_state_with_channel_nest(self) -> None:
        result = get_chat_state(
            ship="sampel-palnet",
            channel_nest="chat/~host/general",
        )
        assert result.data["chat_type"] == TlonChannelType.GROUP.value
        assert result.data["is_group"] is True
        assert result.data["is_dm"] is False
        assert result.data["is_thread"] is False

    def test_thread_state_with_channel_and_reply(self) -> None:
        result = get_chat_state(
            ship="sampel-palnet",
            channel_nest="chat/~host/general",
            reply_to_id="parent-123",
        )
        assert result.data["chat_type"] == TlonChannelType.THREAD.value
        assert result.data["is_thread"] is True
        assert result.data["is_dm"] is False
        assert result.data["is_group"] is False

    def test_values_dict_has_all_keys_as_strings(self) -> None:
        result = get_chat_state(
            ship="sampel-palnet",
            channel_nest="chat/~host/general",
            reply_to_id="parent-123",
            room_id="room-uuid",
        )
        expected_keys = {
            "ship", "channel_nest", "reply_to_id", "room_id",
            "chat_type", "is_dm", "is_group", "is_thread",
        }
        assert set(result.values.keys()) == expected_keys
        for value in result.values.values():
            assert isinstance(value, str)

    def test_values_booleans_are_lowercase_strings(self) -> None:
        result = get_chat_state(ship="ship")
        assert result.values["is_dm"] == "true"
        assert result.values["is_group"] == "false"
        assert result.values["is_thread"] == "false"

    def test_text_contains_ship_with_tilde(self) -> None:
        result = get_chat_state(ship="sampel-palnet")
        assert "Ship: ~sampel-palnet" in result.text

    def test_text_contains_channel_when_present(self) -> None:
        result = get_chat_state(channel_nest="chat/~host/general")
        assert "Channel: chat/~host/general" in result.text

    def test_text_contains_chat_type(self) -> None:
        result = get_chat_state(ship="x")
        assert "Chat Type: dm" in result.text

    def test_text_contains_reply_to_when_present(self) -> None:
        result = get_chat_state(
            channel_nest="chat/~host/ch",
            reply_to_id="parent-id",
        )
        assert "Reply To: parent-id" in result.text

    def test_no_ship_in_text_when_none(self) -> None:
        result = get_chat_state()
        assert "Ship:" not in result.text

    def test_empty_values_when_nothing_provided(self) -> None:
        result = get_chat_state()
        assert result.values["ship"] == ""
        assert result.values["channel_nest"] == ""
        assert result.values["reply_to_id"] == ""
        assert result.values["room_id"] == ""

    def test_room_id_is_passed_through(self) -> None:
        result = get_chat_state(room_id="room-uuid-123")
        assert result.data["room_id"] == "room-uuid-123"
        assert result.values["room_id"] == "room-uuid-123"
