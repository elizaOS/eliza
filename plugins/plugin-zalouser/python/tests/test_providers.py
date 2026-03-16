"""Tests for plugin-zalouser providers module."""

from elizaos_plugin_zalouser.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_zalouser.providers.chat_state import (
    CHAT_STATE_DESCRIPTION,
    CHAT_STATE_PROVIDER_META,
)


class TestChatStateProviderMetadata:
    """Test provider metadata dict."""

    def test_provider_name(self) -> None:
        assert CHAT_STATE_PROVIDER == "zalouser_chat_state"

    def test_meta_name_matches(self) -> None:
        assert CHAT_STATE_PROVIDER_META["name"] == CHAT_STATE_PROVIDER

    def test_meta_has_description(self) -> None:
        assert isinstance(CHAT_STATE_PROVIDER_META["description"], str)
        assert len(CHAT_STATE_PROVIDER_META["description"]) > 0

    def test_meta_is_dynamic(self) -> None:
        assert CHAT_STATE_PROVIDER_META["dynamic"] is True

    def test_description_constant(self) -> None:
        assert isinstance(CHAT_STATE_DESCRIPTION, str)
        assert "Zalo" in CHAT_STATE_DESCRIPTION


class TestGetChatState:
    """Test get_chat_state function."""

    def test_private_chat(self) -> None:
        result = get_chat_state(thread_id="t1", is_group=False)
        assert result.data["is_private"] is True
        assert result.data["is_group"] is False

    def test_group_chat(self) -> None:
        result = get_chat_state(thread_id="t1", is_group=True)
        assert result.data["is_private"] is False
        assert result.data["is_group"] is True

    def test_default_is_private(self) -> None:
        result = get_chat_state(thread_id="t1")
        assert result.data["is_private"] is True

    def test_thread_id_in_data(self) -> None:
        result = get_chat_state(thread_id="t-42")
        assert result.data["thread_id"] == "t-42"
        assert result.values["thread_id"] == "t-42"

    def test_user_id_in_data(self) -> None:
        result = get_chat_state(user_id="u-1")
        assert result.data["user_id"] == "u-1"
        assert result.values["user_id"] == "u-1"

    def test_sender_id_in_data(self) -> None:
        result = get_chat_state(sender_id="s-1")
        assert result.data["sender_id"] == "s-1"
        assert result.values["sender_id"] == "s-1"

    def test_room_id_in_data(self) -> None:
        result = get_chat_state(room_id="r-1")
        assert result.data["room_id"] == "r-1"

    def test_text_contains_header(self) -> None:
        result = get_chat_state()
        assert "Zalo User Chat State" in result.text

    def test_text_contains_thread_id(self) -> None:
        result = get_chat_state(thread_id="t-99")
        assert "t-99" in result.text

    def test_text_contains_group_type(self) -> None:
        result = get_chat_state(thread_id="t-1", is_group=True)
        assert "Group" in result.text

    def test_text_contains_private_type(self) -> None:
        result = get_chat_state(thread_id="t-1", is_group=False)
        assert "Private" in result.text

    def test_empty_defaults(self) -> None:
        result = get_chat_state()
        assert result.values["thread_id"] == ""
        assert result.values["user_id"] == ""
        assert result.values["sender_id"] == ""
        assert result.values["room_id"] == ""


class TestChatStateResult:
    """Test ChatStateResult dataclass."""

    def test_construction(self) -> None:
        r = ChatStateResult(data={"thread_id": "t1"})
        assert r.data["thread_id"] == "t1"
        assert r.values == {}
        assert r.text == ""
