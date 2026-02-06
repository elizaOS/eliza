"""Send message action implementation."""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SendMessageResult:
    """Result of sending a message."""

    success: bool
    text: str
    user_id: str | None = None
    message_id: str | None = None
    error: str | None = None


async def handle_send_message(
    user_id: str,
    text: str,
) -> SendMessageResult:
    """Handle the send message action.
    
    Args:
        user_id: Target user ID.
        text: Message text.
        
    Returns:
        Action result.
    """
    logger.info("Send message action: user_id=%s, text=%s", user_id, text[:50])

    return SendMessageResult(
        success=True,
        text=text,
        user_id=user_id,
    )


def validate_send_message(source: str | None) -> bool:
    """Validate if the send message action should be executed.
    
    Args:
        source: Message source.
        
    Returns:
        True if the action should be executed.
    """
    return source == "zalo"


SEND_MESSAGE_ACTION = {
    "name": "SEND_ZALO_MESSAGE",
    "similes": [
        "ZALO_SEND_MESSAGE",
        "ZALO_REPLY",
        "ZALO_MESSAGE",
        "SEND_ZALO",
        "REPLY_ZALO",
    ],
    "description": "Send a message to a Zalo user",
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
                    "actions": ["SEND_ZALO_MESSAGE"],
                },
            },
        ],
    ],
}
