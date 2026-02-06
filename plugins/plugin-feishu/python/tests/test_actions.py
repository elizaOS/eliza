import pytest

from elizaos_plugin_feishu.actions import (
    SEND_MESSAGE_ACTION,
    handle_send_message,
    validate_send_message,
)


class TestSendMessageAction:
    def test_action_metadata(self):
        """Test action metadata."""
        assert SEND_MESSAGE_ACTION["name"] == "SEND_FEISHU_MESSAGE"
        assert "FEISHU_SEND_MESSAGE" in SEND_MESSAGE_ACTION["similes"]
        assert "LARK_SEND_MESSAGE" in SEND_MESSAGE_ACTION["similes"]
        assert len(SEND_MESSAGE_ACTION["examples"]) > 0

    def test_validate_feishu_source(self):
        """Test validation with Feishu source."""
        assert validate_send_message("feishu") is True

    def test_validate_non_feishu_source(self):
        """Test validation with non-Feishu source."""
        assert validate_send_message("telegram") is False
        assert validate_send_message("discord") is False
        assert validate_send_message(None) is False

    @pytest.mark.asyncio
    async def test_handle_send_message(self):
        """Test handling send message action."""
        result = await handle_send_message(
            chat_id="oc_test123",
            text="Hello, World!",
        )

        assert result.success is True
        assert result.text == "Hello, World!"
        assert result.chat_id == "oc_test123"
        assert result.error is None

    @pytest.mark.asyncio
    async def test_handle_send_message_with_reply(self):
        """Test handling send message with reply."""
        result = await handle_send_message(
            chat_id="oc_test123",
            text="Reply text",
            reply_to_message_id="msg_456",
        )

        assert result.success is True
        assert result.text == "Reply text"
