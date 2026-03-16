"""Tests for the SEND_MESSAGE action and ConversationHistoryProvider."""

from __future__ import annotations

import pytest

from elizaos_plugin_blooio.actions.send_message import SendMessageAction
from elizaos_plugin_blooio.providers.conversation_history import (
    ConversationHistoryProvider,
)
from elizaos_plugin_blooio.service import BlooioService
from elizaos_plugin_blooio.types import ConversationEntry


def _message(text: str) -> dict:
    return {"content": {"text": text}}


# ===========================================================================
# SendMessageAction — validate
# ===========================================================================


async def test_action_validate_with_phone() -> None:
    action = SendMessageAction()
    msg = _message("Send a message to +15551234567 saying hello")
    assert await action.validate(msg, {})


async def test_action_validate_with_email() -> None:
    action = SendMessageAction()
    msg = _message("Message jane@example.com with greetings")
    assert await action.validate(msg, {})


async def test_action_validate_without_chat_id() -> None:
    action = SendMessageAction()
    msg = _message("Just a regular message without any recipient")
    assert not await action.validate(msg, {})


# ===========================================================================
# SendMessageAction — handler
# ===========================================================================


async def test_action_handler_no_service() -> None:
    action = SendMessageAction()
    msg = _message("Send to +15551234567")
    result = await action.handler(msg, {}, None)
    assert not result.success
    assert result.error == "missing_service"


async def test_action_handler_no_recipient() -> None:
    action = SendMessageAction()
    msg = _message("Hello world, no numbers here")
    result = await action.handler(msg, {}, None)
    assert not result.success


async def test_action_handler_sends_message(
    httpx_mock, service: BlooioService  # type: ignore[no-untyped-def]
) -> None:
    httpx_mock.add_response(
        url="https://test.blooio.com/chats/grp_action/messages",
        method="POST",
        json={"success": True, "message_id": "msg_action"},
        status_code=200,
    )

    action = SendMessageAction()
    msg = _message("Send a message to grp_action saying Hi team!")
    result = await action.handler(msg, {}, service)
    assert result.success
    assert "grp_action" in result.text


# ===========================================================================
# ConversationHistoryProvider
# ===========================================================================


async def test_provider_no_service() -> None:
    provider = ConversationHistoryProvider()
    msg = {"content": {"chatId": "+15551234567"}}
    result = await provider.get(msg, {}, None)
    assert "not initialized" in result.text


async def test_provider_no_chat_id(service: BlooioService) -> None:
    provider = ConversationHistoryProvider()
    msg = _message("no identifier here")
    result = await provider.get(msg, {}, service)
    assert "No chat identifier" in result.text


async def test_provider_empty_history(service: BlooioService) -> None:
    provider = ConversationHistoryProvider()
    msg = {"content": {"chatId": "+15551234567"}}
    result = await provider.get(msg, {}, service)
    assert "No recent conversation" in result.text


async def test_provider_with_history(service: BlooioService) -> None:
    service.add_to_history(
        "+15551234567",
        ConversationEntry(
            role="user", text="Hello", timestamp=1000, chat_id="+15551234567"
        ),
    )
    service.add_to_history(
        "+15551234567",
        ConversationEntry(
            role="assistant",
            text="Hi there!",
            timestamp=2000,
            chat_id="+15551234567",
        ),
    )

    provider = ConversationHistoryProvider()
    msg = {"content": {"chatId": "+15551234567"}}
    result = await provider.get(msg, {}, service)
    assert "Hello" in result.text
    assert "Hi there!" in result.text
    assert "+15551234567" in result.text


async def test_provider_extracts_phone_from_text(service: BlooioService) -> None:
    service.add_to_history(
        "+19998887777",
        ConversationEntry(
            role="user", text="Testing", timestamp=3000, chat_id="+19998887777"
        ),
    )

    provider = ConversationHistoryProvider()
    msg = _message("Show conversation with +19998887777")
    result = await provider.get(msg, {}, service)
    assert "Testing" in result.text
