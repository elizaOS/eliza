"""Tests for LINE plugin webhook handling."""

import json

import pytest

from elizaos_plugin_line.webhook import (
    FollowEvent,
    InvalidSignatureError,
    JoinEvent,
    LeaveEvent,
    MessageEvent,
    PostbackEvent,
    UnfollowEvent,
    WebhookHandler,
    WebhookSource,
    compute_signature,
    create_webhook_middleware,
    parse_webhook_body,
    parse_webhook_event,
    validate_signature,
)

# ---------------------------------------------------------------------------
# Signature validation
# ---------------------------------------------------------------------------

SECRET = "test_channel_secret"
BODY = b'{"events":[]}'


def test_validate_signature_valid():
    """Valid signature should pass validation."""
    sig = compute_signature(BODY, SECRET)
    assert validate_signature(BODY, sig, SECRET)


def test_validate_signature_invalid():
    """Invalid signature should fail validation."""
    assert not validate_signature(BODY, "definitely_wrong", SECRET)


def test_validate_signature_wrong_secret():
    """Signature computed with different secret should fail."""
    sig = compute_signature(BODY, SECRET)
    assert not validate_signature(BODY, sig, "wrong_secret")


def test_validate_signature_wrong_body():
    """Signature should fail when body differs."""
    sig = compute_signature(BODY, SECRET)
    assert not validate_signature(b"different body", sig, SECRET)


def test_validate_signature_empty_body():
    """Empty body should still produce a valid signature."""
    sig = compute_signature(b"", SECRET)
    assert validate_signature(b"", sig, SECRET)


def test_compute_signature_deterministic():
    """Same inputs should always produce the same signature."""
    sig1 = compute_signature(BODY, SECRET)
    sig2 = compute_signature(BODY, SECRET)
    assert sig1 == sig2


def test_compute_signature_different_inputs():
    """Different inputs should produce different signatures."""
    sig1 = compute_signature(b"body1", SECRET)
    sig2 = compute_signature(b"body2", SECRET)
    assert sig1 != sig2


# ---------------------------------------------------------------------------
# Event parsing
# ---------------------------------------------------------------------------


def test_parse_follow_event():
    data = {
        "type": "follow",
        "timestamp": 1000,
        "source": {"type": "user", "userId": "U123"},
        "replyToken": "rt1",
    }
    event = parse_webhook_event(data)
    assert isinstance(event, FollowEvent)
    assert event.type == "follow"
    assert event.timestamp == 1000
    assert event.source.user_id == "U123"
    assert event.reply_token == "rt1"


def test_parse_unfollow_event():
    data = {
        "type": "unfollow",
        "timestamp": 2000,
        "source": {"type": "user", "userId": "U456"},
    }
    event = parse_webhook_event(data)
    assert isinstance(event, UnfollowEvent)
    assert event.type == "unfollow"
    assert event.source.user_id == "U456"


def test_parse_join_event():
    data = {
        "type": "join",
        "timestamp": 3000,
        "source": {"type": "group", "groupId": "C789"},
        "replyToken": "rt2",
    }
    event = parse_webhook_event(data)
    assert isinstance(event, JoinEvent)
    assert event.type == "join"
    assert event.source.group_id == "C789"
    assert event.source.type == "group"


def test_parse_leave_event():
    data = {
        "type": "leave",
        "timestamp": 4000,
        "source": {"type": "room", "roomId": "R111"},
    }
    event = parse_webhook_event(data)
    assert isinstance(event, LeaveEvent)
    assert event.type == "leave"
    assert event.source.room_id == "R111"


def test_parse_postback_event():
    data = {
        "type": "postback",
        "timestamp": 5000,
        "source": {"type": "user", "userId": "U123"},
        "replyToken": "rt3",
        "postback": {
            "data": "action=buy&item=123",
            "params": {"date": "2024-01-01"},
        },
    }
    event = parse_webhook_event(data)
    assert isinstance(event, PostbackEvent)
    assert event.data == "action=buy&item=123"
    assert event.params == {"date": "2024-01-01"}
    assert event.reply_token == "rt3"


def test_parse_message_event_text():
    data = {
        "type": "message",
        "timestamp": 6000,
        "source": {"type": "user", "userId": "U123"},
        "replyToken": "rt4",
        "message": {"id": "msg1", "type": "text", "text": "Hello!"},
    }
    event = parse_webhook_event(data)
    assert isinstance(event, MessageEvent)
    assert event.message_id == "msg1"
    assert event.message_type == "text"
    assert event.text == "Hello!"
    assert event.reply_token == "rt4"


def test_parse_message_event_image():
    data = {
        "type": "message",
        "timestamp": 7000,
        "source": {"type": "group", "groupId": "C1", "userId": "U1"},
        "replyToken": "rt5",
        "message": {"id": "img1", "type": "image"},
    }
    event = parse_webhook_event(data)
    assert isinstance(event, MessageEvent)
    assert event.message_type == "image"
    assert event.text is None
    assert event.source.group_id == "C1"


def test_parse_unknown_event():
    data = {"type": "beacon", "timestamp": 0, "source": {"type": "user"}}
    assert parse_webhook_event(data) is None


def test_parse_webhook_body_multiple():
    body = {
        "events": [
            {
                "type": "follow",
                "timestamp": 100,
                "source": {"type": "user", "userId": "U1"},
            },
            {
                "type": "message",
                "timestamp": 200,
                "source": {"type": "user", "userId": "U2"},
                "replyToken": "rt",
                "message": {"id": "m1", "type": "text", "text": "Hi"},
            },
            {
                "type": "unfollow",
                "timestamp": 300,
                "source": {"type": "user", "userId": "U3"},
            },
        ]
    }
    events = parse_webhook_body(body)
    assert len(events) == 3
    assert isinstance(events[0], FollowEvent)
    assert isinstance(events[1], MessageEvent)
    assert isinstance(events[2], UnfollowEvent)


def test_parse_webhook_body_empty():
    assert parse_webhook_body({"events": []}) == []


def test_parse_webhook_body_no_events_key():
    assert parse_webhook_body({}) == []


def test_parse_webhook_body_filters_unknown():
    body = {
        "events": [
            {"type": "follow", "timestamp": 1, "source": {"type": "user", "userId": "U1"}},
            {"type": "beacon", "timestamp": 2, "source": {"type": "user"}},
        ]
    }
    events = parse_webhook_body(body)
    assert len(events) == 1
    assert isinstance(events[0], FollowEvent)


# ---------------------------------------------------------------------------
# WebhookSource
# ---------------------------------------------------------------------------


def test_webhook_source_defaults():
    src = WebhookSource(type="user")
    assert src.type == "user"
    assert src.user_id is None
    assert src.group_id is None
    assert src.room_id is None


def test_webhook_source_with_ids():
    src = WebhookSource(type="group", user_id="U1", group_id="C1")
    assert src.type == "group"
    assert src.user_id == "U1"
    assert src.group_id == "C1"


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


def test_create_webhook_middleware_valid():
    middleware = create_webhook_middleware(SECRET)
    sig = compute_signature(BODY, SECRET)
    assert middleware(BODY, sig) is True


def test_create_webhook_middleware_invalid():
    middleware = create_webhook_middleware(SECRET)
    assert middleware(BODY, "bad") is False


# ---------------------------------------------------------------------------
# WebhookHandler
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_webhook_handler_dispatches():
    """Handler should dispatch events to registered listeners."""
    handler = WebhookHandler(SECRET)
    received = []

    async def on_follow(event):
        received.append(("follow", event))

    async def on_message(event):
        received.append(("message", event))

    handler.on("follow", on_follow).on("message", on_message)

    body_dict = {
        "events": [
            {"type": "follow", "timestamp": 1, "source": {"type": "user", "userId": "U1"}},
            {
                "type": "message",
                "timestamp": 2,
                "source": {"type": "user", "userId": "U2"},
                "replyToken": "rt",
                "message": {"id": "m1", "type": "text", "text": "Hi"},
            },
        ]
    }
    body_bytes = json.dumps(body_dict).encode()
    sig = compute_signature(body_bytes, SECRET)

    events = await handler.handle(body_bytes, sig)

    assert len(events) == 2
    assert len(received) == 2
    assert received[0][0] == "follow"
    assert received[1][0] == "message"


@pytest.mark.asyncio
async def test_webhook_handler_invalid_signature():
    """Handler should raise InvalidSignatureError for bad signatures."""
    handler = WebhookHandler(SECRET)
    body = json.dumps({"events": []}).encode()

    with pytest.raises(InvalidSignatureError):
        await handler.handle(body, "invalid_signature")


@pytest.mark.asyncio
async def test_webhook_handler_chaining():
    """Handler.on() should support method chaining."""
    handler = WebhookHandler(SECRET)

    async def noop(event):
        pass

    result = handler.on("follow", noop).on("message", noop)
    assert result is handler


@pytest.mark.asyncio
async def test_webhook_handler_no_listeners():
    """Handler should work with no registered listeners."""
    handler = WebhookHandler(SECRET)
    body_dict = {
        "events": [
            {"type": "follow", "timestamp": 1, "source": {"type": "user", "userId": "U1"}},
        ]
    }
    body_bytes = json.dumps(body_dict).encode()
    sig = compute_signature(body_bytes, SECRET)

    events = await handler.handle(body_bytes, sig)
    assert len(events) == 1
