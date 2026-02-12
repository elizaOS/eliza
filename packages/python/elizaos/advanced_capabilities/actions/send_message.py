"""Advanced capabilities SEND_MESSAGE action.

Keep this action implementation aligned with bootstrap to guarantee identical
target parsing and dispatch behavior across capability variants.
"""

from elizaos.bootstrap.actions.send_message import (  # re-export for parity
    SendMessageAction,
    send_message_action,
)

__all__ = ["SendMessageAction", "send_message_action"]
