"""
Webhook event handling for the LINE plugin.

Provides webhook signature validation, event parsing, and event dispatch
matching the TypeScript implementation's webhook handling for:
follow, unfollow, join, leave, postback, and message events.
"""

import base64
import hashlib
import hmac
import json
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Webhook event source
# ---------------------------------------------------------------------------


@dataclass
class WebhookSource:
    """Source of a webhook event (user, group, or room)."""

    type: str  # "user", "group", "room"
    user_id: str | None = None
    group_id: str | None = None
    room_id: str | None = None


# ---------------------------------------------------------------------------
# Webhook event types
# ---------------------------------------------------------------------------


@dataclass
class FollowEvent:
    """Emitted when a user adds the bot as a friend."""

    type: str  # always "follow"
    timestamp: int
    source: WebhookSource
    reply_token: str | None = None


@dataclass
class UnfollowEvent:
    """Emitted when a user blocks the bot."""

    type: str  # always "unfollow"
    timestamp: int
    source: WebhookSource


@dataclass
class JoinEvent:
    """Emitted when the bot joins a group or room."""

    type: str  # always "join"
    timestamp: int
    source: WebhookSource
    reply_token: str | None = None


@dataclass
class LeaveEvent:
    """Emitted when the bot is removed from a group or room."""

    type: str  # always "leave"
    timestamp: int
    source: WebhookSource


@dataclass
class PostbackEvent:
    """Emitted when a user triggers a postback action."""

    type: str  # always "postback"
    timestamp: int
    source: WebhookSource
    data: str
    params: dict | None = None
    reply_token: str | None = None


@dataclass
class MessageEvent:
    """Emitted when a user sends a message."""

    type: str  # always "message"
    timestamp: int
    source: WebhookSource
    message_id: str
    message_type: str
    reply_token: str | None = None
    text: str | None = None
    mention: dict | None = None


# Union type alias for all webhook events
WebhookEvent = (
    FollowEvent | UnfollowEvent | JoinEvent | LeaveEvent | PostbackEvent | MessageEvent
)


# ---------------------------------------------------------------------------
# Signature validation
# ---------------------------------------------------------------------------


class InvalidSignatureError(Exception):
    """Raised when webhook signature validation fails."""


def validate_signature(body: bytes, signature: str, channel_secret: str) -> bool:
    """Validate a LINE webhook signature using HMAC-SHA256.

    Args:
        body: Raw request body bytes.
        signature: The X-Line-Signature header value (base64-encoded).
        channel_secret: The channel secret from LINE Developer Console.

    Returns:
        True if the signature is valid.
    """
    hash_value = hmac.new(
        channel_secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).digest()
    expected = base64.b64encode(hash_value).decode("utf-8")
    return hmac.compare_digest(signature, expected)


def compute_signature(body: bytes, channel_secret: str) -> str:
    """Compute a LINE webhook signature for the given body and secret.

    Args:
        body: Raw request body bytes.
        channel_secret: The channel secret.

    Returns:
        Base64-encoded HMAC-SHA256 signature.
    """
    hash_value = hmac.new(
        channel_secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).digest()
    return base64.b64encode(hash_value).decode("utf-8")


# ---------------------------------------------------------------------------
# Event parsing
# ---------------------------------------------------------------------------


def _parse_source(data: dict) -> WebhookSource:
    """Parse a webhook event source from JSON data."""
    return WebhookSource(
        type=data.get("type", "user"),
        user_id=data.get("userId"),
        group_id=data.get("groupId"),
        room_id=data.get("roomId"),
    )


def parse_webhook_event(data: dict) -> WebhookEvent | None:
    """Parse a single webhook event from its JSON representation.

    Returns None for unrecognised event types.
    """
    event_type = data.get("type", "")
    timestamp = data.get("timestamp", 0)
    source = _parse_source(data.get("source", {}))
    reply_token = data.get("replyToken")

    if event_type == "follow":
        return FollowEvent(
            type="follow",
            timestamp=timestamp,
            source=source,
            reply_token=reply_token,
        )

    if event_type == "unfollow":
        return UnfollowEvent(type="unfollow", timestamp=timestamp, source=source)

    if event_type == "join":
        return JoinEvent(
            type="join",
            timestamp=timestamp,
            source=source,
            reply_token=reply_token,
        )

    if event_type == "leave":
        return LeaveEvent(type="leave", timestamp=timestamp, source=source)

    if event_type == "postback":
        pb = data.get("postback", {})
        return PostbackEvent(
            type="postback",
            timestamp=timestamp,
            source=source,
            data=pb.get("data", ""),
            params=pb.get("params"),
            reply_token=reply_token,
        )

    if event_type == "message":
        msg = data.get("message", {})
        return MessageEvent(
            type="message",
            timestamp=timestamp,
            source=source,
            message_id=msg.get("id", ""),
            message_type=msg.get("type", ""),
            reply_token=reply_token,
            text=msg.get("text"),
            mention=msg.get("mention"),
        )

    logger.warning("Unknown webhook event type: %s", event_type)
    return None


def parse_webhook_body(body: dict) -> list[WebhookEvent]:
    """Parse all events from a webhook request body.

    Args:
        body: Parsed JSON body of the webhook request.

    Returns:
        List of parsed webhook events.
    """
    events: list[WebhookEvent] = []
    for event_data in body.get("events", []):
        event = parse_webhook_event(event_data)
        if event is not None:
            events.append(event)
    return events


# ---------------------------------------------------------------------------
# Webhook middleware
# ---------------------------------------------------------------------------


def create_webhook_middleware(channel_secret: str):
    """Create a middleware callable for webhook signature validation.

    Returns:
        A callable ``(body: bytes, signature: str) -> bool``.
    """

    def middleware(body: bytes, signature: str) -> bool:
        return validate_signature(body, signature, channel_secret)

    return middleware


# ---------------------------------------------------------------------------
# Webhook handler
# ---------------------------------------------------------------------------


class WebhookHandler:
    """Handler that validates, parses, and dispatches LINE webhook events.

    Usage::

        handler = WebhookHandler(channel_secret)
        handler.on("message", my_message_handler)
        handler.on("follow", my_follow_handler)
        events = await handler.handle(raw_body, signature)
    """

    def __init__(self, channel_secret: str):
        self.channel_secret = channel_secret
        self._listeners: dict[str, list] = {}

    def on(self, event_type: str, callback) -> "WebhookHandler":
        """Register a callback for a specific event type.

        Args:
            event_type: One of "follow", "unfollow", "join", "leave",
                        "postback", "message".
            callback: An async callable receiving the event.

        Returns:
            self, for chaining.
        """
        self._listeners.setdefault(event_type, []).append(callback)
        return self

    async def handle(self, body: bytes, signature: str) -> list[WebhookEvent]:
        """Validate the signature, parse events, and dispatch to listeners.

        Raises:
            InvalidSignatureError: If the signature does not match.
        """
        if not validate_signature(body, signature, self.channel_secret):
            raise InvalidSignatureError("Invalid webhook signature")

        body_json = json.loads(body)
        events = parse_webhook_body(body_json)

        for event in events:
            for callback in self._listeners.get(event.type, []):
                await callback(event)

        return events
