"""Chat state provider for Tlon."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from elizaos_plugin_tlon.types import TlonChannelType

logger = logging.getLogger(__name__)


@dataclass
class ChatStateResult:
    """Result of a chat state query."""

    data: dict[str, str | bool | None]
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


def get_chat_state(
    ship: str | None = None,
    channel_nest: str | None = None,
    reply_to_id: str | None = None,
    room_id: str | None = None,
) -> ChatStateResult:
    """Get the current Tlon chat state.

    Args:
        ship: The ship involved in the conversation
        channel_nest: The channel nest (for group messages)
        reply_to_id: The parent message ID (for thread replies)
        room_id: The room ID

    Returns:
        The chat state result
    """
    # Determine chat type
    if channel_nest:
        chat_type = TlonChannelType.THREAD if reply_to_id else TlonChannelType.GROUP
    else:
        chat_type = TlonChannelType.DM

    is_dm = chat_type == TlonChannelType.DM
    is_group = chat_type == TlonChannelType.GROUP
    is_thread = chat_type == TlonChannelType.THREAD

    data: dict[str, str | bool | None] = {
        "ship": ship,
        "channel_nest": channel_nest,
        "reply_to_id": reply_to_id,
        "room_id": room_id,
        "chat_type": chat_type.value,
        "is_dm": is_dm,
        "is_group": is_group,
        "is_thread": is_thread,
    }

    values: dict[str, str] = {
        "ship": ship or "",
        "channel_nest": channel_nest or "",
        "reply_to_id": reply_to_id or "",
        "room_id": room_id or "",
        "chat_type": chat_type.value,
        "is_dm": str(is_dm).lower(),
        "is_group": str(is_group).lower(),
        "is_thread": str(is_thread).lower(),
    }

    text = "Tlon Chat State:\n"
    if ship:
        text += f"Ship: ~{ship}\n"
    if channel_nest:
        text += f"Channel: {channel_nest}\n"
    text += f"Chat Type: {chat_type.value}\n"
    if reply_to_id:
        text += f"Reply To: {reply_to_id}\n"

    return ChatStateResult(data=data, values=values, text=text)


CHAT_STATE_PROVIDER = {
    "name": "tlon_chat_state",
    "description": "Provides Tlon/Urbit chat context including ship, channel, and message type",
    "dynamic": True,
}
