"""Tests for Tlon plugin actions."""

from __future__ import annotations

import pytest

from elizaos_plugin_tlon.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
    validate_send_message,
)


# ---------------------------------------------------------------------------
# SEND_MESSAGE_ACTION metadata
# ---------------------------------------------------------------------------
class TestSendMessageActionMetadata:
    """Tests for the SEND_MESSAGE_ACTION dict."""

    def test_action_name_is_send_tlon_message(self) -> None:
        assert SEND_MESSAGE_ACTION["name"] == "SEND_TLON_MESSAGE"

    def test_has_8_similes(self) -> None:
        similes = SEND_MESSAGE_ACTION["similes"]
        assert len(similes) == 8

    def test_similes_include_tlon_aliases(self) -> None:
        similes = SEND_MESSAGE_ACTION["similes"]
        assert "TLON_SEND_MESSAGE" in similes
        assert "SEND_TLON" in similes
        assert "TLON_REPLY" in similes

    def test_similes_include_urbit_aliases(self) -> None:
        similes = SEND_MESSAGE_ACTION["similes"]
        assert "URBIT_SEND_MESSAGE" in similes
        assert "URBIT_MESSAGE" in similes
        assert "SEND_URBIT" in similes

    def test_description_mentions_tlon_or_urbit(self) -> None:
        desc = SEND_MESSAGE_ACTION["description"].lower()
        assert "tlon" in desc or "urbit" in desc

    def test_has_at_least_two_examples(self) -> None:
        assert len(SEND_MESSAGE_ACTION["examples"]) >= 2

    def test_examples_have_two_messages_each(self) -> None:
        for example in SEND_MESSAGE_ACTION["examples"]:
            assert len(example) == 2  # user message + agent response

    def test_agent_response_includes_action_name(self) -> None:
        for example in SEND_MESSAGE_ACTION["examples"]:
            agent_msg = example[1]
            assert "SEND_TLON_MESSAGE" in agent_msg["content"]["actions"]


# ---------------------------------------------------------------------------
# validate_send_message
# ---------------------------------------------------------------------------
class TestValidateSendMessage:
    """Tests for the validate_send_message function."""

    def test_returns_true_for_tlon_source(self) -> None:
        assert validate_send_message("tlon") is True

    def test_returns_true_for_urbit_source(self) -> None:
        assert validate_send_message("urbit") is True

    def test_returns_false_for_discord_source(self) -> None:
        assert validate_send_message("discord") is False

    def test_returns_false_for_telegram_source(self) -> None:
        assert validate_send_message("telegram") is False

    def test_returns_false_for_none(self) -> None:
        assert validate_send_message(None) is False

    def test_returns_false_for_empty_string(self) -> None:
        assert validate_send_message("") is False


# ---------------------------------------------------------------------------
# SendMessageResult dataclass
# ---------------------------------------------------------------------------
class TestSendMessageResult:
    """Tests for the SendMessageResult dataclass."""

    def test_success_result(self) -> None:
        result = SendMessageResult(
            success=True,
            text="Hello",
            message_id="msg-123",
            target="sampel-palnet",
        )
        assert result.success is True
        assert result.text == "Hello"
        assert result.message_id == "msg-123"
        assert result.target == "sampel-palnet"
        assert result.error is None

    def test_failure_result(self) -> None:
        result = SendMessageResult(
            success=False,
            text="",
            error="Something went wrong",
        )
        assert result.success is False
        assert result.error == "Something went wrong"
        assert result.message_id is None
        assert result.target is None

    def test_defaults_are_none(self) -> None:
        result = SendMessageResult(success=True, text="hi")
        assert result.message_id is None
        assert result.target is None
        assert result.error is None


# ---------------------------------------------------------------------------
# handle_send_message
# ---------------------------------------------------------------------------
class TestHandleSendMessage:
    """Tests for the handle_send_message async function."""

    @pytest.mark.asyncio()
    async def test_returns_success_result(self) -> None:
        result = await handle_send_message(
            target="sampel-palnet",
            text="Hello from test",
        )
        assert result.success is True
        assert result.text == "Hello from test"
        assert result.target == "sampel-palnet"

    @pytest.mark.asyncio()
    async def test_dm_flag_does_not_change_result_success(self) -> None:
        result = await handle_send_message(
            target="sampel-palnet",
            text="DM test",
            is_dm=True,
        )
        assert result.success is True

    @pytest.mark.asyncio()
    async def test_reply_to_id_is_accepted(self) -> None:
        result = await handle_send_message(
            target="chat/~host/channel",
            text="Thread reply",
            is_dm=False,
            reply_to_id="parent-id",
        )
        assert result.success is True
        assert result.target == "chat/~host/channel"

    @pytest.mark.asyncio()
    async def test_long_text_is_preserved(self) -> None:
        long_text = "A" * 5000
        result = await handle_send_message(
            target="ship",
            text=long_text,
        )
        assert result.text == long_text
