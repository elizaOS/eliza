"""Tests for Telegram plugin actions."""

import pytest

from elizaos_plugin_telegram.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
)
from elizaos_plugin_telegram.actions.send_message import validate_send_message


class TestSendMessageAction:
    """Tests for SEND_TELEGRAM_MESSAGE action."""

    def test_action_metadata(self) -> None:
        """Test action has correct metadata."""
        assert SEND_MESSAGE_ACTION["name"] == "SEND_TELEGRAM_MESSAGE"
        assert SEND_MESSAGE_ACTION["description"]
        assert "TELEGRAM_SEND_MESSAGE" in SEND_MESSAGE_ACTION["similes"]

    def test_validate_telegram_source(self) -> None:
        """Test validation accepts telegram source."""
        assert validate_send_message("telegram") is True

    def test_validate_non_telegram_source(self) -> None:
        """Test validation rejects non-telegram source."""
        assert validate_send_message("discord") is False
        assert validate_send_message(None) is False
        assert validate_send_message("slack") is False

    def test_send_message_result_dataclass(self) -> None:
        """Test SendMessageResult dataclass."""
        result = SendMessageResult(
            success=True,
            text="Hello world",
            chat_id=12345,
            message_id=67890,
        )
        assert result.success
        assert result.text == "Hello world"
        assert result.chat_id == 12345
        assert result.error is None


class TestSendMessageHandler:
    """Tests for send message handler."""

    @pytest.mark.asyncio
    async def test_handle_send_message(self) -> None:
        """Test handle_send_message function."""
        from elizaos_plugin_telegram.actions.send_message import handle_send_message

        result = await handle_send_message(
            chat_id=12345,
            text="Test message",
            reply_to_message_id=67890,
        )

        assert result.success
        assert result.chat_id == 12345
        assert result.text == "Test message"
