"""SEND_MESSAGE action — sends a message via Blooio."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from elizaos_plugin_blooio.constants import (
    INVALID_CHAT_ID,
    NO_VALID_RECIPIENT,
    SERVICE_NOT_AVAILABLE,
)
from elizaos_plugin_blooio.types import ActionResult, MessageTarget
from elizaos_plugin_blooio.utils import (
    extract_chat_id_candidates,
    extract_urls,
    validate_chat_id,
)

if TYPE_CHECKING:
    from elizaos_plugin_blooio.service import BlooioService

_CMD_RE = re.compile(r"(?i)send\s+(a\s+)?(message|text|imessage|sms)?\s*(to)?\s*")


class SendMessageAction:
    """Action that sends a message via Blooio to a phone, email, or group."""

    def name(self) -> str:
        return "SEND_MESSAGE"

    def similes(self) -> list[str]:
        return ["SEND_TEXT", "SEND_IMESSAGE", "MESSAGE", "TEXT"]

    def description(self) -> str:
        return "Send a message via Blooio to a chat (phone, email, or group)"

    async def validate(self, message: dict, state: dict) -> bool:  # noqa: ARG002
        text = (message.get("content") or {}).get("text", "")
        candidates = extract_chat_id_candidates(text)
        return any(validate_chat_id(c) for c in candidates)

    async def handler(
        self,
        message: dict,
        state: dict,  # noqa: ARG002
        service: BlooioService | None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(
                success=False,
                text=SERVICE_NOT_AVAILABLE,
                error="missing_service",
            )

        text: str = (message.get("content") or {}).get("text", "")
        candidates = extract_chat_id_candidates(text)
        valid = [c for c in candidates if validate_chat_id(c)]

        if not valid:
            return ActionResult(
                success=False,
                text=NO_VALID_RECIPIENT,
                error="no_recipient",
            )

        chat_id_str = valid[0]
        target = MessageTarget.from_str(chat_id_str)
        if target is None:
            return ActionResult(
                success=False,
                text=INVALID_CHAT_ID,
                error="invalid_target",
            )

        # Strip chat IDs and URLs to isolate the message body.
        content = text
        for cid in valid:
            content = content.replace(cid, "")
        urls = extract_urls(content)
        for url in urls:
            content = content.replace(url, "")
        content = _CMD_RE.sub("", content).strip()
        if not content:
            content = "Hello from your assistant."

        try:
            resp = await service.send_message(target, content, urls or None)
            return ActionResult(
                success=True,
                text=f"Message sent successfully to {chat_id_str}",
                data={
                    "success": resp.success,
                    "message_id": resp.message_id,
                },
            )
        except Exception as exc:
            return ActionResult(
                success=False,
                text=f"Failed to send message: {exc}",
                error=str(exc),
            )

    def examples(self) -> list[dict]:
        return [
            {
                "user_message": "Send a message to +17147023671 saying 'Hello from Blooio!'",
                "agent_response": "I'll send that message.",
            },
            {
                "user_message": "Message jane@example.com with 'Your iMessage is ready.'",
                "agent_response": "Sending that now.",
            },
        ]
