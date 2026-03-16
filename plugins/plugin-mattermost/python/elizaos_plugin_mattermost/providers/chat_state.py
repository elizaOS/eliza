from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from elizaos_plugin_mattermost.types import get_channel_kind

logger = logging.getLogger(__name__)


@dataclass
class ChatStateResult:
    """Result of the chat state provider."""

    data: dict[str, int | str | bool | None]
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


def get_chat_state(
    channel_id: str | None = None,
    user_id: str | None = None,
    post_id: str | None = None,
    root_id: str | None = None,
    team_id: str | None = None,
    channel_type: str | None = None,
    room_id: str | None = None,
) -> ChatStateResult:
    """Get the current chat state.

    Args:
        channel_id: The Mattermost channel ID.
        user_id: The Mattermost user ID.
        post_id: The post ID.
        root_id: The root post ID (for threads).
        team_id: The team ID.
        channel_type: The channel type (D, G, O, P).
        room_id: The elizaOS room ID.

    Returns:
        ChatStateResult with data, values, and text representation.
    """
    kind = get_channel_kind(channel_type)
    is_dm = kind == "dm"
    is_group = kind == "group"
    is_channel = kind == "channel"
    is_thread = bool(root_id)

    data: dict[str, int | str | bool | None] = {
        "channel_id": channel_id,
        "user_id": user_id,
        "post_id": post_id,
        "root_id": root_id,
        "team_id": team_id,
        "channel_type": channel_type,
        "room_id": room_id,
        "is_dm": is_dm,
        "is_group": is_group,
        "is_channel": is_channel,
        "is_thread": is_thread,
    }

    values: dict[str, str] = {
        "channel_id": channel_id or "",
        "user_id": user_id or "",
        "post_id": post_id or "",
        "root_id": root_id or "",
        "team_id": team_id or "",
        "channel_type": channel_type or "",
        "room_id": room_id or "",
        "is_dm": str(is_dm).lower(),
        "is_group": str(is_group).lower(),
        "is_channel": str(is_channel).lower(),
        "is_thread": str(is_thread).lower(),
    }

    text = "Mattermost Chat State:\n"
    if channel_id:
        text += f"Channel ID: {channel_id}\n"
    if channel_type:
        type_label = "Direct Message" if is_dm else "Group Message" if is_group else "Channel"
        text += f"Channel Type: {type_label}\n"
    if user_id:
        text += f"User ID: {user_id}\n"
    if team_id:
        text += f"Team ID: {team_id}\n"
    if root_id:
        text += f"Thread Root: {root_id}\n"

    return ChatStateResult(data=data, values=values, text=text)


CHAT_STATE_PROVIDER: dict[str, Any] = {
    "name": "mattermost_chat_state",
    "description": "Provides Mattermost chat context including channel ID, user ID, team ID, and channel type",
    "dynamic": True,
}
