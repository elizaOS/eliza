"""Action interfaces and built-in actions for the MS Teams service."""

from elizaos_plugin_msteams.actions.send_message import (
    SendAdaptiveCardAction,
    SendMessageAction,
    SendPollAction,
)

__all__ = [
    "SendMessageAction",
    "SendPollAction",
    "SendAdaptiveCardAction",
]
