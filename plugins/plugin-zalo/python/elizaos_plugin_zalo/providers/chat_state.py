"""Chat state provider implementation."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ChatStateResult:
    """Result from the chat state provider."""

    data: dict[str, str | bool | None]
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


def get_chat_state(
    user_id: str | None = None,
    chat_id: str | None = None,
    room_id: str | None = None,
) -> ChatStateResult:
    """Get the current Zalo chat state.
    
    Args:
        user_id: User ID.
        chat_id: Chat ID (same as user_id for Zalo OA).
        room_id: Room/conversation ID.
        
    Returns:
        Chat state result.
    """
    # Zalo OA only supports private chats
    is_private = True

    data: dict[str, str | bool | None] = {
        "user_id": user_id,
        "chat_id": chat_id or user_id,
        "room_id": room_id,
        "is_private": is_private,
        "platform": "zalo",
    }

    values: dict[str, str] = {
        "user_id": user_id or "",
        "chat_id": chat_id or user_id or "",
        "room_id": room_id or "",
        "is_private": "true",
        "platform": "zalo",
    }

    text = "Zalo Chat State:\n"
    if user_id:
        text += f"User ID: {user_id}\n"
    text += "Chat Type: Private (DM)\n"
    text += "Platform: Zalo Official Account\n"

    return ChatStateResult(data=data, values=values, text=text)


CHAT_STATE_PROVIDER = {
    "name": "zalo_chat_state",
    "description": "Provides Zalo chat context including user ID and chat metadata",
    "dynamic": True,
}
