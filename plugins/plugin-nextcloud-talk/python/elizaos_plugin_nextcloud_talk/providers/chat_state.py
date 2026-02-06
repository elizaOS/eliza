from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ChatStateResult:
    """Result from chat state provider."""

    data: dict[str, str | bool | None]
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


def get_chat_state(
    room_token: str | None = None,
    sender_id: str | None = None,
    room_name: str | None = None,
    room_id: str | None = None,
    is_group_chat: bool | None = None,
    base_url: str | None = None,
) -> ChatStateResult:
    """Get the current chat state."""
    is_group = is_group_chat if is_group_chat is not None else False
    is_private = not is_group if is_group_chat is not None else False

    data: dict[str, str | bool | None] = {
        "room_token": room_token,
        "sender_id": sender_id,
        "room_name": room_name,
        "room_id": room_id,
        "is_group_chat": is_group,
        "is_private": is_private,
        "base_url": base_url,
    }

    values: dict[str, str] = {
        "room_token": room_token or "",
        "sender_id": sender_id or "",
        "room_name": room_name or "",
        "room_id": room_id or "",
        "is_group_chat": str(is_group).lower(),
        "is_private": str(is_private).lower(),
        "base_url": base_url or "",
    }

    text = "Nextcloud Talk Chat State:\n"
    if room_token:
        text += f"Room Token: {room_token}\n"
    if room_name:
        text += f"Room Name: {room_name}\n"
    if is_group_chat is not None:
        text += f"Room Type: {'Group' if is_group else 'Private (1:1)'}\n"
    if sender_id:
        text += f"Sender ID: {sender_id}\n"
    if base_url:
        text += f"Nextcloud URL: {base_url}\n"

    return ChatStateResult(data=data, values=values, text=text)


CHAT_STATE_PROVIDER = {
    "name": "nextcloud_talk_chat_state",
    "description": "Provides Nextcloud Talk chat context including room token, sender ID, and room type",
    "dynamic": True,
}
