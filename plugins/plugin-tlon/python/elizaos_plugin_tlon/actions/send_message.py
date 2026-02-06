"""Send message action for Tlon."""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class SendMessageResult:
    """Result of a send message action."""

    success: bool
    text: str
    message_id: str | None = None
    target: str | None = None
    error: str | None = None


async def handle_send_message(
    target: str,
    text: str,
    is_dm: bool = False,
    reply_to_id: str | None = None,
) -> SendMessageResult:
    """Handle a send message action.

    This creates the result payload. The actual sending should be done
    by the service using the TlonService.send_dm or TlonService.send_channel_message.

    Args:
        target: The target ship (for DMs) or channel nest (for groups)
        text: The message text
        is_dm: Whether this is a DM
        reply_to_id: Optional parent message ID for thread replies

    Returns:
        The action result
    """
    logger.info(f"Send message action: target={target}, text={text[:50]}...")

    return SendMessageResult(
        success=True,
        text=text,
        target=target,
    )


def validate_send_message(source: str | None) -> bool:
    """Validate whether a message can be handled by this action.

    Args:
        source: The message source

    Returns:
        True if the source is tlon or urbit
    """
    return source in ("tlon", "urbit")


SEND_MESSAGE_ACTION = {
    "name": "SEND_TLON_MESSAGE",
    "similes": [
        "TLON_SEND_MESSAGE",
        "TLON_REPLY",
        "TLON_MESSAGE",
        "SEND_TLON",
        "REPLY_TLON",
        "URBIT_SEND_MESSAGE",
        "URBIT_MESSAGE",
        "SEND_URBIT",
    ],
    "description": "Send a message via Tlon/Urbit to a ship or channel",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Send a message to this Tlon chat"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll send a message via Tlon now.",
                    "actions": ["SEND_TLON_MESSAGE"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Reply to this message on Urbit"},
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll reply to your message on Urbit.",
                    "actions": ["SEND_TLON_MESSAGE"],
                },
            },
        ],
    ],
}
