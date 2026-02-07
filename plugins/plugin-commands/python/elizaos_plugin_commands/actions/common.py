"""Common types shared across actions."""

from __future__ import annotations

from typing import Any, TypedDict


class MessageContent(TypedDict, total=False):
    text: str


class Message(TypedDict, total=False):
    content: MessageContent
    room_id: str
    agent_id: str
    entity_id: str
    model_provider: str
    model_name: str


def get_text(message: Message) -> str:
    """Extract text content from a message."""
    content = message.get("content")
    if content is None:
        return ""
    return content.get("text", "")


def get_field(message: Message | dict[str, Any], key: str, default: str = "unknown") -> str:
    """Safely get a string field from a message dict."""
    val = message.get(key)  # type: ignore[union-attr]
    if isinstance(val, str):
        return val
    return default
