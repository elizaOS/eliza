"""Send message action for Zalo User."""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

SEND_MESSAGE_ACTION = "SEND_ZALOUSER_MESSAGE"

SEND_MESSAGE_SIMILES = [
    "ZALOUSER_SEND_MESSAGE",
    "ZALOUSER_REPLY",
    "ZALOUSER_MESSAGE",
    "SEND_ZALO",
    "REPLY_ZALO",
    "ZALO_SEND",
    "ZALO_MESSAGE",
]

SEND_MESSAGE_DESCRIPTION = "Send a message to a Zalo chat via personal account"


@dataclass
class SendMessageActionResult:
    """Result of send message action."""

    success: bool
    action: str
    thread_id: str
    text: str
    message_id: str | None = None
    error: str | None = None


async def handle_send_message(
    thread_id: str,
    text: str,
    is_group: bool = False,
) -> SendMessageActionResult:
    """Handle send message action.
    
    Note: This is a placeholder that should be called through the service.
    """
    logger.info("Send message action: thread_id=%s, text=%s...", thread_id, text[:50])

    return SendMessageActionResult(
        success=True,
        action=SEND_MESSAGE_ACTION,
        thread_id=thread_id,
        text=text,
    )


def validate_send_message(source: str | None) -> bool:
    """Validate that this action should handle the message."""
    return source == "zalouser"


# Action metadata for registration
SEND_MESSAGE_ACTION_META = {
    "name": SEND_MESSAGE_ACTION,
    "similes": SEND_MESSAGE_SIMILES,
    "description": SEND_MESSAGE_DESCRIPTION,
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Send a message to this Zalo chat"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll send a message to this chat now.",
                    "actions": [SEND_MESSAGE_ACTION],
                },
            },
        ],
    ],
}
