from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ChatStateResult:
    data: dict[str, int | str | bool | None]
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


def get_chat_state(
    chat_id: int | None = None,
    user_id: int | None = None,
    thread_id: int | None = None,
    room_id: str | None = None,
) -> ChatStateResult:
    is_private = chat_id is not None and chat_id > 0
    is_group = chat_id is not None and chat_id < 0

    data: dict[str, int | str | bool | None] = {
        "chat_id": chat_id,
        "user_id": user_id,
        "thread_id": thread_id,
        "room_id": room_id,
        "is_private": is_private,
        "is_group": is_group,
    }

    values: dict[str, str] = {
        "chat_id": str(chat_id) if chat_id else "",
        "user_id": str(user_id) if user_id else "",
        "thread_id": str(thread_id) if thread_id else "",
        "room_id": room_id or "",
        "is_private": str(is_private).lower(),
        "is_group": str(is_group).lower(),
    }

    text = "Telegram Chat State:\n"
    if chat_id:
        text += f"Chat ID: {chat_id}\n"
        text += f"Chat Type: {'Private' if is_private else 'Group'}\n"
    if user_id:
        text += f"User ID: {user_id}\n"
    if thread_id:
        text += f"Thread ID: {thread_id}\n"

    return ChatStateResult(data=data, values=values, text=text)


CHAT_STATE_PROVIDER = {
    "name": "telegram_chat_state",
    "description": "Provides Telegram chat context including chat ID, user ID, and chat type",
    "dynamic": True,
}
