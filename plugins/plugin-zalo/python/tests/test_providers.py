"""Tests for plugin-zalo providers module."""

from elizaos_plugin_zalo.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)


class TestChatStateProviderMetadata:
    """Test CHAT_STATE_PROVIDER dict metadata."""

    def test_provider_name(self) -> None:
        assert CHAT_STATE_PROVIDER["name"] == "zalo_chat_state"

    def test_provider_has_description(self) -> None:
        assert isinstance(CHAT_STATE_PROVIDER["description"], str)
        assert len(CHAT_STATE_PROVIDER["description"]) > 0

    def test_provider_is_dynamic(self) -> None:
        assert CHAT_STATE_PROVIDER["dynamic"] is True


class TestGetChatState:
    """Test get_chat_state function."""

    def test_with_user_id(self) -> None:
        result = get_chat_state(user_id="u-42")
        assert result.data["user_id"] == "u-42"
        assert result.values["user_id"] == "u-42"

    def test_chat_id_defaults_to_user_id(self) -> None:
        result = get_chat_state(user_id="u-42")
        assert result.data["chat_id"] == "u-42"

    def test_chat_id_with_explicit_value(self) -> None:
        result = get_chat_state(user_id="u-42", chat_id="c-99")
        assert result.data["chat_id"] == "c-99"

    def test_platform_is_zalo(self) -> None:
        result = get_chat_state()
        assert result.data["platform"] == "zalo"

    def test_is_private_always_true(self) -> None:
        result = get_chat_state()
        assert result.data["is_private"] is True

    def test_text_contains_header(self) -> None:
        result = get_chat_state()
        assert "Zalo Chat State" in result.text

    def test_text_includes_user_id_when_present(self) -> None:
        result = get_chat_state(user_id="u-1")
        assert "u-1" in result.text

    def test_text_includes_platform(self) -> None:
        result = get_chat_state()
        assert "Zalo Official Account" in result.text

    def test_empty_values_for_missing_fields(self) -> None:
        result = get_chat_state()
        assert result.values["user_id"] == ""
        assert result.values["chat_id"] == ""
        assert result.values["room_id"] == ""

    def test_room_id_passthrough(self) -> None:
        result = get_chat_state(room_id="room-abc")
        assert result.data["room_id"] == "room-abc"
        assert result.values["room_id"] == "room-abc"


class TestChatStateResult:
    """Test ChatStateResult dataclass."""

    def test_construction(self) -> None:
        r = ChatStateResult(data={"platform": "zalo"})
        assert r.data["platform"] == "zalo"
        assert r.values == {}
        assert r.text == ""
