from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SendMessageResult:
    """Result of a send message action."""

    success: bool
    text: str
    chat_id: str | None = None
    message_id: str | None = None
    error: str | None = None


async def handle_send_message(
    chat_id: str,
    text: str,
    reply_to_message_id: str | None = None,
) -> SendMessageResult:
    """Handles the send message action.

    This function prepares the result payload. The actual sending
    is handled by the service.
    """
    logger.info("Send message action: chat_id=%s, text=%s", chat_id, text[:50])

    return SendMessageResult(
        success=True,
        text=text,
        chat_id=chat_id,
    )


def validate_send_message(source: str | None) -> bool:
    """Validates that the source is Feishu."""
    return source == "feishu"


SEND_MESSAGE_ACTION = {
    "name": "SEND_FEISHU_MESSAGE",
    "similes": [
        "FEISHU_SEND_MESSAGE",
        "FEISHU_REPLY",
        "FEISHU_MESSAGE",
        "SEND_FEISHU",
        "REPLY_FEISHU",
        "LARK_SEND_MESSAGE",
        "LARK_REPLY",
        "SEND_LARK",
    ],
    "description": "Send a message to a Feishu/Lark chat",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Send a message to this Feishu chat"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll send a message to this chat now.",
                    "actions": ["SEND_FEISHU_MESSAGE"],
                },
            },
        ],
    ],
}
