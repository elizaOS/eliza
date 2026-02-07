"""Blooio messaging service — HTTP client wrapper with conversation history."""

from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from elizaos_plugin_blooio.constants import MAX_CONVERSATION_HISTORY
from elizaos_plugin_blooio.types import (
    BlooioConfig,
    BlooioError,
    BlooioResponse,
    ConversationEntry,
    MessageTarget,
)
from elizaos_plugin_blooio.utils import validate_chat_id, verify_webhook_signature

logger = logging.getLogger(__name__)


class BlooioService:
    """HTTP client for the Blooio API with in-memory conversation history."""

    def __init__(self, config: BlooioConfig) -> None:
        self._config = config
        self._client = httpx.AsyncClient()
        self._conversation_history: dict[str, list[ConversationEntry]] = {}
        self._max_history = MAX_CONVERSATION_HISTORY
        logger.info("BlooioService initialized")

    @property
    def config(self) -> BlooioConfig:
        return self._config

    # -- messaging ----------------------------------------------------------------

    async def send_message(
        self,
        target: MessageTarget,
        text: str,
        attachments: list[str] | None = None,
    ) -> BlooioResponse:
        """Send a message to *target* via the Blooio API."""
        chat_id = target.chat_id

        if not validate_chat_id(chat_id):
            raise BlooioError("Invalid chat identifier", details=chat_id)

        encoded_id = quote(chat_id, safe="")
        url = f"{self._config.api_base_url}/chats/{encoded_id}/messages"

        body: dict = {"text": text}
        if attachments:
            body["attachments"] = attachments

        response = await self._client.post(
            url,
            json=body,
            headers={
                "Authorization": f"Bearer {self._config.api_key}",
                "Content-Type": "application/json",
            },
        )

        if response.status_code >= 400:
            raise BlooioError(
                f"Blooio API error ({response.status_code})",
                status_code=response.status_code,
                details=response.text,
            )

        data = response.json()
        return BlooioResponse(
            success=data.get("success", False),
            message_id=data.get("message_id"),
            error=data.get("error"),
        )

    # -- conversation history -----------------------------------------------------

    def get_conversation_history(
        self,
        chat_id: str,
        limit: int = 10,
    ) -> list[ConversationEntry]:
        """Return the most recent *limit* history entries for *chat_id*."""
        entries = self._conversation_history.get(chat_id, [])
        if limit <= 0:
            return []
        return entries[-limit:]

    def add_to_history(self, chat_id: str, entry: ConversationEntry) -> None:
        """Append a conversation entry for the given chat."""
        entries = self._conversation_history.setdefault(chat_id, [])
        entries.append(entry)
        if len(entries) > self._max_history:
            self._conversation_history[chat_id] = entries[-self._max_history :]

    # -- webhook ------------------------------------------------------------------

    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        """Verify an incoming webhook payload against the configured secret."""
        if self._config.webhook_secret is None:
            logger.warning("No webhook secret configured, skipping verification")
            return True
        return verify_webhook_signature(payload, signature, self._config.webhook_secret)
