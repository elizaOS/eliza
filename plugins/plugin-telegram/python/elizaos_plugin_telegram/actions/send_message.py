"""Send message action for Telegram."""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SendMessageResult:
    """Result of a send message action."""

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
    """Handle send message action.

    Note: This action is typically used as a callback definition.
    The actual sending is done by the TelegramService.

    Args:
        chat_id: The chat ID to send the message to.
        text: The message text to send.
        reply_to_message_id: Optional message ID to reply to.

    Returns:
        The action result.
    """
    logger.info("Send message action: chat_id=%s, text=%s", chat_id, text[:50])

    # This is a placeholder - actual sending is done by the service
    return SendMessageResult(
        success=True,
        text=text,
        chat_id=chat_id,
    )


def validate_send_message(source: str | None) -> bool:
    """Validate if this is a Telegram message.

    Args:
        source: The message source.

    Returns:
        True if the source is telegram.
    """
    return source == "telegram"


# Action definition for elizaOS integration
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
