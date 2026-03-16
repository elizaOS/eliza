"""Tests for Telegram plugin providers."""

from elizaos_plugin_telegram.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)


class TestChatStateProvider:
    """Tests for telegram_chat_state provider."""

    def test_provider_metadata(self) -> None:
        """Test provider has correct metadata."""
        assert CHAT_STATE_PROVIDER["name"] == "telegram_chat_state"
        assert CHAT_STATE_PROVIDER["description"]
        assert CHAT_STATE_PROVIDER["dynamic"] is True

    def test_chat_state_result_dataclass(self) -> None:
        """Test ChatStateResult dataclass."""
        result = ChatStateResult(
            data={"chat_id": 12345, "is_private": True},
            values={"chat_id": "12345"},
            text="Test state",
        )
        assert result.data["chat_id"] == 12345
        assert result.values["chat_id"] == "12345"

    def test_get_chat_state_private(self) -> None:
        """Test get_chat_state for private chat."""
        result = get_chat_state(
            chat_id=12345,
            user_id=12345,
            room_id="room-uuid",
        )

        assert result.data["chat_id"] == 12345
        assert result.data["is_private"] is True
        assert result.data["is_group"] is False
        assert "Private" in result.text

    def test_get_chat_state_group(self) -> None:
        """Test get_chat_state for group chat."""
        result = get_chat_state(
            chat_id=-12345,
            user_id=67890,
            thread_id=1,
            room_id="room-uuid",
        )

        assert result.data["chat_id"] == -12345
        assert result.data["is_private"] is False
        assert result.data["is_group"] is True
        assert "Group" in result.text

    def test_get_chat_state_values(self) -> None:
        """Test get_chat_state values mapping."""
        result = get_chat_state(
            chat_id=12345,
            user_id=67890,
            thread_id=1,
            room_id="test-room",
        )

        assert result.values["chat_id"] == "12345"
        assert result.values["user_id"] == "67890"
        assert result.values["thread_id"] == "1"
        assert result.values["room_id"] == "test-room"
        assert result.values["is_private"] == "true"
        assert result.values["is_group"] == "false"
