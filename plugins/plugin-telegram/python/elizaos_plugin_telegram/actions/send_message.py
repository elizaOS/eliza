from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SendMessageResult:
    success: bool
    text: str
    chat_id: int | None = None
    message_id: int | None = None
    error: str | None = None


async def handle_send_message(
    chat_id: int,
    text: str,
    reply_to_message_id: int | None = None,
) -> SendMessageResult:
    logger.info("Send message action: chat_id=%s, text=%s", chat_id, text[:50])

    return SendMessageResult(
        success=True,
        text=text,
        chat_id=chat_id,
    )


def validate_send_message(source: str | None) -> bool:
    return source == "telegram"


SEND_MESSAGE_ACTION = {
    "name": "SEND_TELEGRAM_MESSAGE",
    "similes": [
        "TELEGRAM_SEND_MESSAGE",
        "TELEGRAM_REPLY",
        "TELEGRAM_MESSAGE",
        "SEND_TELEGRAM",
        "REPLY_TELEGRAM",
    ],
    "description": "Send a message to a Telegram chat",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Send a message to this Telegram chat"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll send a message to this chat now.",
                    "actions": ["SEND_TELEGRAM_MESSAGE"],
                },
            },
        ],
    ],
}
