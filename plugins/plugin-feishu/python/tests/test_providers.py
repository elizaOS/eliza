import pytest

from elizaos_plugin_feishu.providers import CHAT_STATE_PROVIDER, get_chat_state


class TestChatStateProvider:
    def test_provider_metadata(self):
        """Test provider metadata."""
        assert CHAT_STATE_PROVIDER["name"] == "FEISHU_CHAT_STATE"
        assert len(CHAT_STATE_PROVIDER["description"]) > 0

    def test_get_chat_state_feishu_source(self):
        """Test getting chat state with Feishu source."""
        result = get_chat_state(
            source="feishu",
            chat_id="oc_test123",
            message_id="msg_456",
        )

        assert result is not None
        assert "Feishu/Lark" in result
        assert "oc_test123" in result
        assert "msg_456" in result

    def test_get_chat_state_non_feishu_source(self):
        """Test getting chat state with non-Feishu source."""
        result = get_chat_state(
            source="telegram",
            chat_id="oc_test123",
        )

        assert result is None

    def test_get_chat_state_no_chat_id(self):
        """Test getting chat state without chat ID."""
        result = get_chat_state(
            source="feishu",
            chat_id=None,
        )

        assert result is None

    def test_get_chat_state_with_extras(self):
        """Test getting chat state with extra information."""
        result = get_chat_state(
            source="feishu",
            chat_id="oc_test123",
            message_id="msg_456",
            chat_type="group",
            chat_name="Test Group",
        )

        assert result is not None
        assert "group" in result
        assert "Test Group" in result
