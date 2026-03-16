"""Conversation history provider for the Blooio plugin."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from elizaos_plugin_blooio.types import ProviderResult

if TYPE_CHECKING:
    from elizaos_plugin_blooio.service import BlooioService

_CHAT_ID_RE = re.compile(
    r"(\+\d{1,15}|grp_[A-Za-z0-9]+|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})"
)


class ConversationHistoryProvider:
    """Provider that exposes recent Blooio conversation history to the runtime."""

    def name(self) -> str:
        return "CONVERSATION_HISTORY"

    def description(self) -> str:
        return "Provides recent Blooio conversation history with a chat"

    def position(self) -> int:
        return 90

    async def get(
        self,
        message: dict,
        state: dict,  # noqa: ARG002
        service: BlooioService | None,
    ) -> ProviderResult:
        if service is None:
            return ProviderResult(
                values={"conversationHistory": "Service not available"},
                text="No Blooio conversation history available - service not initialized",
                data={"messageCount": 0},
            )

        content = message.get("content") or {}

        # Try multiple sources for the chat identifier.
        chat_id: str | None = None
        if isinstance(content.get("chatId"), str):
            chat_id = content["chatId"]
        elif isinstance(content.get("phoneNumber"), str):
            chat_id = content["phoneNumber"]
        elif isinstance(content.get("text"), str):
            m = _CHAT_ID_RE.search(content["text"])
            if m:
                chat_id = m.group(1)

        if not chat_id:
            return ProviderResult(
                values={"conversationHistory": "No chat identifier found"},
                text="No chat identifier found in context",
                data={"messageCount": 0},
            )

        history = service.get_conversation_history(chat_id, 10)

        if not history:
            return ProviderResult(
                values={"conversationHistory": f"No recent history with {chat_id}"},
                text=f"No recent conversation history with {chat_id}",
                data={"chatId": chat_id, "messageCount": 0},
            )

        formatted = [
            f"[{entry.timestamp}] {entry.role}: {entry.text}" for entry in history
        ]
        history_text = "\n".join(formatted)
        last = history[-1]

        return ProviderResult(
            values={
                "conversationHistory": history_text,
                "chatId": chat_id,
            },
            text=f"Recent Blooio conversation with {chat_id}:\n{history_text}",
            data={
                "chatId": chat_id,
                "messageCount": len(history),
                "lastMessage": {
                    "role": last.role,
                    "text": last.text,
                    "timestamp": last.timestamp,
                },
            },
        )
