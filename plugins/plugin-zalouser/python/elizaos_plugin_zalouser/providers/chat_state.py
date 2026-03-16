"""Chat state provider for Zalo User."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

CHAT_STATE_PROVIDER = "zalouser_chat_state"
CHAT_STATE_DESCRIPTION = (
    "Provides Zalo User chat context including thread ID, user ID, and chat type"
)


@dataclass
class ChatStateResult:
    """Chat state result."""

    data: dict[str, str | bool | None]
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


def get_chat_state(
    thread_id: str | None = None,
    user_id: str | None = None,
    sender_id: str | None = None,
    room_id: str | None = None,
    is_group: bool | None = None,
) -> ChatStateResult:
    """Get chat state from message context."""
    is_group_val = is_group if is_group is not None else False
    is_private = not is_group_val

    data: dict[str, str | bool | None] = {
        "thread_id": thread_id,
        "user_id": user_id,
        "sender_id": sender_id,
        "room_id": room_id,
        "is_private": is_private,
        "is_group": is_group_val,
    }

    values: dict[str, str] = {
        "thread_id": thread_id or "",
        "user_id": user_id or "",
        "sender_id": sender_id or "",
        "room_id": room_id or "",
        "is_private": str(is_private).lower(),
        "is_group": str(is_group_val).lower(),
    }

    text = "Zalo User Chat State:\n"
    if thread_id:
        text += f"Thread ID: {thread_id}\n"
        text += f"Chat Type: {'Group' if is_group_val else 'Private'}\n"
    if user_id:
        text += f"User ID: {user_id}\n"
    if sender_id:
        text += f"Sender ID: {sender_id}\n"

    return ChatStateResult(data=data, values=values, text=text)


# Provider metadata for registration
CHAT_STATE_PROVIDER_META = {
    "name": CHAT_STATE_PROVIDER,
    "description": CHAT_STATE_DESCRIPTION,
    "dynamic": True,
}
