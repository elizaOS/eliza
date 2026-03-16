from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ChatStateResult:
    """Result from the chat state provider."""

    platform: str
    chat_id: str
    message_id: str | None = None
    chat_type: str | None = None
    chat_name: str | None = None


def get_chat_state(
    source: str | None,
    chat_id: str | None,
    message_id: str | None = None,
    chat_type: str | None = None,
    chat_name: str | None = None,
) -> str | None:
    """Gets the chat state as a formatted string.

    Args:
        source: The message source (should be "feishu" for this provider)
        chat_id: The chat ID
        message_id: Optional message ID
        chat_type: Optional chat type (p2p or group)
        chat_name: Optional chat name

    Returns:
        Formatted state string or None if not a Feishu message
    """
    if source != "feishu":
        return None

    if not chat_id:
        return None

    state_info = [
        "Platform: Feishu/Lark",
        f"Chat ID: {chat_id}",
    ]

    if message_id:
        state_info.append(f"Message ID: {message_id}")

    if chat_type:
        state_info.append(f"Chat Type: {chat_type}")

    if chat_name:
        state_info.append(f"Chat Name: {chat_name}")

    return "\n".join(state_info)


CHAT_STATE_PROVIDER = {
    "name": "FEISHU_CHAT_STATE",
    "description": "Provides Feishu chat context and state information",
}
