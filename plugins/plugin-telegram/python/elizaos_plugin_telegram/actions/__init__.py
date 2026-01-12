"""Actions for the Telegram plugin."""

from elizaos_plugin_telegram.actions.send_message import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)

__all__ = [
    "SEND_MESSAGE_ACTION",
    "SendMessageResult",
    "handle_send_message",
]
