"""Tests for plugin-zalo actions module."""

import pytest

from elizaos_plugin_zalo.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
    validate_send_message,
)


class TestSendMessageActionMetadata:
    """Test SEND_MESSAGE_ACTION dict metadata."""

    def test_action_name(self) -> None:
        assert SEND_MESSAGE_ACTION["name"] == "SEND_ZALO_MESSAGE"

    def test_action_has_similes(self) -> None:
        assert isinstance(SEND_MESSAGE_ACTION["similes"], list)
        assert len(SEND_MESSAGE_ACTION["similes"]) >= 1

    def test_action_has_description(self) -> None:
        assert isinstance(SEND_MESSAGE_ACTION["description"], str)
        assert len(SEND_MESSAGE_ACTION["description"]) > 0

    def test_action_has_examples(self) -> None:
        assert "examples" in SEND_MESSAGE_ACTION
        assert len(SEND_MESSAGE_ACTION["examples"]) >= 1

    def test_similes_are_strings(self) -> None:
        for simile in SEND_MESSAGE_ACTION["similes"]:
            assert isinstance(simile, str)


class TestValidateSendMessage:
    """Test validate_send_message function."""

    def test_returns_true_for_zalo(self) -> None:
        assert validate_send_message("zalo") is True

    def test_returns_false_for_telegram(self) -> None:
        assert validate_send_message("telegram") is False

    def test_returns_false_for_none(self) -> None:
        assert validate_send_message(None) is False

    def test_returns_false_for_empty(self) -> None:
        assert validate_send_message("") is False

    def test_case_sensitive(self) -> None:
        assert validate_send_message("Zalo") is False
        assert validate_send_message("ZALO") is False


class TestHandleSendMessage:
    """Test handle_send_message async handler."""

    @pytest.mark.asyncio()
    async def test_returns_success_result(self) -> None:
        result = await handle_send_message(user_id="u1", text="Hello")
        assert result.success is True
        assert result.text == "Hello"
        assert result.user_id == "u1"

    @pytest.mark.asyncio()
    async def test_error_field_is_none_on_success(self) -> None:
        result = await handle_send_message(user_id="u1", text="Hi")
        assert result.error is None

    @pytest.mark.asyncio()
    async def test_message_id_is_none(self) -> None:
        result = await handle_send_message(user_id="u1", text="Hi")
        assert result.message_id is None


class TestSendMessageResult:
    """Test SendMessageResult dataclass."""

    def test_construction(self) -> None:
        r = SendMessageResult(
            success=True, text="hello", user_id="u1", message_id="m1"
        )
        assert r.success is True
        assert r.text == "hello"
        assert r.user_id == "u1"
        assert r.message_id == "m1"

    def test_defaults(self) -> None:
        r = SendMessageResult(success=False, text="err")
        assert r.user_id is None
        assert r.message_id is None
        assert r.error is None
