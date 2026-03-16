"""Tests for plugin-zalouser actions module."""

import pytest

from elizaos_plugin_zalouser.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageActionResult,
    handle_send_message,
    validate_send_message,
)
from elizaos_plugin_zalouser.actions.send_message import (
    SEND_MESSAGE_ACTION_META,
    SEND_MESSAGE_DESCRIPTION,
    SEND_MESSAGE_SIMILES,
)


class TestSendMessageActionMetadata:
    """Test action metadata dict."""

    def test_action_name(self) -> None:
        assert SEND_MESSAGE_ACTION == "SEND_ZALOUSER_MESSAGE"

    def test_meta_name_matches(self) -> None:
        assert SEND_MESSAGE_ACTION_META["name"] == SEND_MESSAGE_ACTION

    def test_meta_has_similes(self) -> None:
        assert isinstance(SEND_MESSAGE_ACTION_META["similes"], list)
        assert len(SEND_MESSAGE_ACTION_META["similes"]) >= 1

    def test_meta_has_description(self) -> None:
        assert isinstance(SEND_MESSAGE_ACTION_META["description"], str)
        assert len(SEND_MESSAGE_ACTION_META["description"]) > 0

    def test_meta_has_examples(self) -> None:
        assert "examples" in SEND_MESSAGE_ACTION_META
        assert len(SEND_MESSAGE_ACTION_META["examples"]) >= 1

    def test_similes_constant(self) -> None:
        assert isinstance(SEND_MESSAGE_SIMILES, list)
        assert "ZALOUSER_SEND_MESSAGE" in SEND_MESSAGE_SIMILES

    def test_description_constant(self) -> None:
        assert isinstance(SEND_MESSAGE_DESCRIPTION, str)
        assert "Zalo" in SEND_MESSAGE_DESCRIPTION


class TestValidateSendMessage:
    """Test validate_send_message function."""

    def test_returns_true_for_zalouser(self) -> None:
        assert validate_send_message("zalouser") is True

    def test_returns_false_for_zalo(self) -> None:
        assert validate_send_message("zalo") is False

    def test_returns_false_for_telegram(self) -> None:
        assert validate_send_message("telegram") is False

    def test_returns_false_for_none(self) -> None:
        assert validate_send_message(None) is False

    def test_returns_false_for_empty(self) -> None:
        assert validate_send_message("") is False

    def test_case_sensitive(self) -> None:
        assert validate_send_message("ZaloUser") is False
        assert validate_send_message("ZALOUSER") is False


class TestHandleSendMessage:
    """Test handle_send_message async handler."""

    @pytest.mark.asyncio()
    async def test_returns_success(self) -> None:
        result = await handle_send_message(thread_id="t1", text="Hello")
        assert result.success is True
        assert result.action == SEND_MESSAGE_ACTION
        assert result.thread_id == "t1"
        assert result.text == "Hello"

    @pytest.mark.asyncio()
    async def test_error_is_none_on_success(self) -> None:
        result = await handle_send_message(thread_id="t1", text="Hi")
        assert result.error is None

    @pytest.mark.asyncio()
    async def test_message_id_is_none(self) -> None:
        result = await handle_send_message(thread_id="t1", text="Hi")
        assert result.message_id is None

    @pytest.mark.asyncio()
    async def test_with_group_flag(self) -> None:
        result = await handle_send_message(
            thread_id="t1", text="Hello group", is_group=True
        )
        assert result.success is True


class TestSendMessageActionResult:
    """Test dataclass construction."""

    def test_construction(self) -> None:
        r = SendMessageActionResult(
            success=True,
            action="SEND_ZALOUSER_MESSAGE",
            thread_id="t1",
            text="hello",
            message_id="m1",
        )
        assert r.success is True
        assert r.action == "SEND_ZALOUSER_MESSAGE"

    def test_defaults(self) -> None:
        r = SendMessageActionResult(
            success=False,
            action="SEND_ZALOUSER_MESSAGE",
            thread_id="t1",
            text="err",
        )
        assert r.message_id is None
        assert r.error is None
