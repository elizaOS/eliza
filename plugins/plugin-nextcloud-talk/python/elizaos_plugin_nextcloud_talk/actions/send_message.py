from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SendMessageResult:
    """Result from send message action."""

    success: bool
    text: str
    room_token: str | None = None
    message_id: str | None = None
    error: str | None = None


async def handle_send_message(
    room_token: str,
    text: str,
    reply_to_message_id: str | None = None,
) -> SendMessageResult:
    """Handle send message action."""
    logger.info("Send message action: room_token=%s, text=%s", room_token, text[:50])

    return SendMessageResult(
        success=True,
        text=text,
        room_token=room_token,
    )


def validate_send_message(source: str | None) -> bool:
    """Validate if this action can be executed for the given source."""
    return source == "nextcloud-talk"


SEND_MESSAGE_ACTION = {
    "name": "SEND_NEXTCLOUD_TALK_MESSAGE",
    "similes": [
        "NEXTCLOUD_TALK_SEND_MESSAGE",
        "NEXTCLOUD_TALK_REPLY",
        "NEXTCLOUD_TALK_MESSAGE",
        "NC_TALK_SEND",
        "NC_TALK_REPLY",
    ],
    "description": "Send a message to a Nextcloud Talk room",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Send a message to this Nextcloud Talk room"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll send a message to this room now.",
                    "actions": ["SEND_NEXTCLOUD_TALK_MESSAGE"],
                },
            },
        ],
    ],
}
