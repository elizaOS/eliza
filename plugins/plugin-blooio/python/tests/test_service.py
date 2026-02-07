"""Tests for BlooioService (httpx mocking via pytest-httpx)."""

from __future__ import annotations

import hashlib
import hmac as hmac_mod

import pytest

from elizaos_plugin_blooio.service import BlooioService
from elizaos_plugin_blooio.types import (
    BlooioConfig,
    BlooioError,
    ConversationEntry,
    MessageTarget,
)


# ---------------------------------------------------------------------------
# send_message
# ---------------------------------------------------------------------------


async def test_send_message_success(httpx_mock, service: BlooioService) -> None:  # type: ignore[no-untyped-def]
    httpx_mock.add_response(
        url="https://test.blooio.com/chats/grp_test123/messages",
        method="POST",
        json={"success": True, "message_id": "msg_001"},
        status_code=200,
    )

    target = MessageTarget.group_id("grp_test123")
    resp = await service.send_message(target, "Hello")

    assert resp.success
    assert resp.message_id == "msg_001"


async def test_send_message_api_error(httpx_mock, service: BlooioService) -> None:  # type: ignore[no-untyped-def]
    httpx_mock.add_response(
        url="https://test.blooio.com/chats/grp_err/messages",
        method="POST",
        text="Internal Server Error",
        status_code=500,
    )

    target = MessageTarget.group_id("grp_err")
    with pytest.raises(BlooioError) as exc_info:
        await service.send_message(target, "Hello")

    assert exc_info.value.status_code == 500


async def test_send_message_with_attachments(httpx_mock, service: BlooioService) -> None:  # type: ignore[no-untyped-def]
    httpx_mock.add_response(
        url="https://test.blooio.com/chats/grp_attach/messages",
        method="POST",
        json={"success": True, "message_id": "msg_002"},
        status_code=200,
    )

    target = MessageTarget.group_id("grp_attach")
    resp = await service.send_message(
        target, "Check this", attachments=["https://img.example.com/pic.png"]
    )
    assert resp.success


async def test_send_message_invalid_target(service: BlooioService) -> None:
    target = MessageTarget.phone("bad_number")
    with pytest.raises(BlooioError):
        await service.send_message(target, "Hello")


# ---------------------------------------------------------------------------
# conversation history
# ---------------------------------------------------------------------------


def test_conversation_history_add_and_retrieve(service: BlooioService) -> None:
    service.add_to_history(
        "chat1",
        ConversationEntry(role="user", text="Hello", timestamp=1000, chat_id="chat1"),
    )
    service.add_to_history(
        "chat1",
        ConversationEntry(
            role="assistant", text="Hi there", timestamp=2000, chat_id="chat1"
        ),
    )

    history = service.get_conversation_history("chat1", 10)
    assert len(history) == 2
    assert history[0].text == "Hello"
    assert history[1].text == "Hi there"


def test_conversation_history_empty(service: BlooioService) -> None:
    assert service.get_conversation_history("nonexistent", 10) == []


def test_conversation_history_with_limit(service: BlooioService) -> None:
    for i in range(5):
        service.add_to_history(
            "chat2",
            ConversationEntry(
                role="user",
                text=f"Message {i}",
                timestamp=i * 1000,
                chat_id="chat2",
            ),
        )

    history = service.get_conversation_history("chat2", 2)
    assert len(history) == 2
    assert history[0].text == "Message 3"
    assert history[1].text == "Message 4"


def test_conversation_history_limit_zero(service: BlooioService) -> None:
    service.add_to_history(
        "chat3",
        ConversationEntry(role="user", text="hello", timestamp=100, chat_id="chat3"),
    )
    assert service.get_conversation_history("chat3", 0) == []


# ---------------------------------------------------------------------------
# webhook verification
# ---------------------------------------------------------------------------


def test_verify_webhook_with_secret(
    service_with_secret: BlooioService,
) -> None:
    secret = "test_webhook_secret"
    payload = b"request body"
    timestamp = "1700000000"

    msg = f"{timestamp}.{payload.decode()}"
    sig = hmac_mod.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    header = f"t={timestamp},v1={sig}"

    assert service_with_secret.verify_webhook(payload, header)


def test_verify_webhook_no_secret(service: BlooioService) -> None:
    # No secret configured ⇒ verification is skipped (returns True).
    assert service.verify_webhook(b"anything", "any_sig")


def test_verify_webhook_wrong_signature(
    service_with_secret: BlooioService,
) -> None:
    bad_sig = "0" * 64
    header = f"t=123,v1={bad_sig}"
    assert not service_with_secret.verify_webhook(b"body", header)
