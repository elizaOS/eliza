from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict


class MessageContent(TypedDict, total=False):
    text: str


class Message(TypedDict, total=False):
    content: MessageContent
    room_id: str
    agent_id: str


@dataclass(frozen=True)
class ActionResult:
    success: bool
    text: str
    error: str | None = None


def conversation_id(message: Message) -> str:
    return message.get("room_id") or message.get("agent_id") or "default"
