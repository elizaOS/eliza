"""Actions for the Telegram plugin."""

from elizaos_plugin_telegram.actions.send_message import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)
from elizaos_plugin_telegram.actions.send_reaction import (
    normalize_reaction,
    REACTION_NAME_MAP,
    send_reaction_action,
    SendReactionAction,
)

__all__ = [
    "SEND_MESSAGE_ACTION",
    "SendMessageResult",
    "handle_send_message",
    "send_reaction_action",
    "SendReactionAction",
    "normalize_reaction",
    "REACTION_NAME_MAP",
]
