from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class SendMessageResult:
    """Result of sending a message."""

    success: bool
    text: str
    channel_id: str | None = None
    post_id: str | None = None
    root_id: str | None = None
    error: str | None = None


async def handle_send_message(
    channel_id: str,
    text: str,
    root_id: str | None = None,
) -> SendMessageResult:
    """Handle a send message action.

    This function prepares the message payload but doesn't actually send it.
    The actual sending is handled by the service when this action is executed.
    """
    logger.info("Send message action: channel_id=%s, text=%s...", channel_id, text[:50])

    return SendMessageResult(
        success=True,
        text=text,
        channel_id=channel_id,
        root_id=root_id,
    )


def validate_send_message(source: str | None) -> bool:
    """Validate if the send message action can run."""
    return source == "mattermost"


SEND_MESSAGE_ACTION: dict[str, Any] = {
    "name": "SEND_MATTERMOST_MESSAGE",
    "similes": [
        "MATTERMOST_SEND_MESSAGE",
        "MATTERMOST_REPLY",
        "MATTERMOST_MESSAGE",
        "SEND_MATTERMOST",
        "REPLY_MATTERMOST",
        "POST_MATTERMOST",
    ],
    "description": "Send a message to a Mattermost channel or user",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Send a message to this Mattermost channel"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll send a message to this channel now.",
                    "actions": ["SEND_MATTERMOST_MESSAGE"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Reply to this thread"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll reply to this thread.",
                    "actions": ["SEND_MATTERMOST_MESSAGE"],
                },
            },
        ],
    ],
}
