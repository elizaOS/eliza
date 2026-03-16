"""BlueBubbles API client."""

import asyncio
import logging
from typing import Any
from urllib.parse import quote

import httpx

from elizaos_plugin_bluebubbles.config import BlueBubblesConfig
from elizaos_plugin_bluebubbles.types import (
    BlueBubblesChat,
    BlueBubblesMessage,
    BlueBubblesProbeResult,
    BlueBubblesServerInfo,
    SendMessageOptions,
    SendMessageResult,
)

logger = logging.getLogger(__name__)


class BlueBubblesClient:
    """Client for interacting with the BlueBubbles server."""

    def __init__(self, config: BlueBubblesConfig):
        """Initializes the client."""
        self.base_url = config.server_url.rstrip("/")
        self.password = config.password
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        """Closes the HTTP client."""
        await self._client.aclose()

    def _build_url(self, endpoint: str) -> str:
        """Builds a URL with password authentication."""
        separator = "&" if "?" in endpoint else "?"
        return f"{self.base_url}{endpoint}{separator}password={quote(self.password)}"

    async def _get(self, endpoint: str) -> dict[str, Any]:
        """Makes a GET request."""
        url = self._build_url(endpoint)
        logger.debug("GET %s", endpoint)

        response = await self._client.get(url)

        if not response.is_success:
            raise Exception(
                f"BlueBubbles API error ({response.status_code}): {response.text}"
            )

        return response.json()["data"]

    async def _post(self, endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
        """Makes a POST request."""
        url = self._build_url(endpoint)
        logger.debug("POST %s", endpoint)

        response = await self._client.post(url, json=body)

        if not response.is_success:
            raise Exception(
                f"BlueBubbles API error ({response.status_code}): {response.text}"
            )

        return response.json()["data"]

    async def probe(self, timeout_ms: int = 5000) -> BlueBubblesProbeResult:
        """Probes the server to check connectivity."""
        try:
            async with asyncio.timeout(timeout_ms / 1000):
                url = self._build_url("/api/v1/server/info")
                response = await self._client.get(url)

                if not response.is_success:
                    return BlueBubblesProbeResult(
                        ok=False, error=f"HTTP {response.status_code}"
                    )

                data = response.json()["data"]
                info = BlueBubblesServerInfo(**data)

                return BlueBubblesProbeResult(
                    ok=True,
                    server_version=info.server_version,
                    os_version=info.os_version,
                    private_api_enabled=info.private_api,
                    helper_connected=info.helper_connected,
                )
        except asyncio.TimeoutError:
            return BlueBubblesProbeResult(ok=False, error="Connection timeout")
        except Exception as e:
            return BlueBubblesProbeResult(ok=False, error=str(e))

    async def send_message(
        self,
        chat_guid: str,
        text: str,
        options: SendMessageOptions | None = None,
    ) -> SendMessageResult:
        """Sends a text message."""
        opts = options or SendMessageOptions()

        body: dict[str, Any] = {
            "chatGuid": chat_guid,
            "message": text,
            "method": opts.method or "apple-script",
        }

        if opts.temp_guid:
            body["tempGuid"] = opts.temp_guid
        if opts.subject:
            body["subject"] = opts.subject
        if opts.effect_id:
            body["effectId"] = opts.effect_id

        data = await self._post("/api/v1/message/text", body)
        message = BlueBubblesMessage(**data)

        logger.info("Sent message: %s", message.guid)

        return SendMessageResult(
            guid=message.guid,
            temp_guid=opts.temp_guid,
            status="sent",
            date_created=message.date_created,
            text=message.text or text,
        )

    async def get_chat(self, chat_guid: str) -> BlueBubblesChat:
        """Gets information about a chat."""
        data = await self._get(f"/api/v1/chat/{quote(chat_guid)}")
        return BlueBubblesChat(**data)

    async def list_chats(
        self, limit: int = 100, offset: int = 0
    ) -> list[BlueBubblesChat]:
        """Lists all chats."""
        data = await self._get(
            f"/api/v1/chat?limit={limit}&offset={offset}&with=lastMessage,participants"
        )
        return [BlueBubblesChat(**chat) for chat in data]

    async def get_messages(
        self, chat_guid: str, limit: int = 50, offset: int = 0
    ) -> list[BlueBubblesMessage]:
        """Gets messages for a chat."""
        data = await self._get(
            f"/api/v1/chat/{quote(chat_guid)}/message?limit={limit}&offset={offset}"
        )
        return [BlueBubblesMessage(**msg) for msg in data]

    async def mark_chat_read(self, chat_guid: str) -> None:
        """Marks a chat as read."""
        await self._post(f"/api/v1/chat/{quote(chat_guid)}/read", {})

    async def react_to_message(
        self, chat_guid: str, message_guid: str, reaction: str
    ) -> None:
        """Sends a reaction to a message."""
        await self._post(
            "/api/v1/message/react",
            {
                "chatGuid": chat_guid,
                "messageGuid": message_guid,
                "reaction": reaction,
            },
        )

    async def edit_message(self, message_guid: str, new_text: str) -> None:
        """Edits a message (requires private API)."""
        await self._post(
            f"/api/v1/message/{quote(message_guid)}/edit",
            {
                "editedMessage": new_text,
                "backwardsCompatibilityMessage": new_text,
            },
        )

    async def unsend_message(self, message_guid: str) -> None:
        """Unsends a message (requires private API)."""
        await self._post(f"/api/v1/message/{quote(message_guid)}/unsend", {})

    async def resolve_target(self, target: str) -> str:
        """Resolves a target to a chat GUID."""
        # If it already looks like a chat GUID, return it
        if target.startswith("iMessage;") or target.startswith("SMS;"):
            return target

        # If it looks like a chat ID, query for it
        if target.startswith("chat_"):
            chats = await self.list_chats(100, 0)
            for chat in chats:
                if (
                    chat.chat_identifier == target
                    or chat.guid == target
                    or target in chat.chat_identifier
                ):
                    return chat.guid

        # Otherwise, construct a DM chat GUID
        return f"iMessage;-;{target}"

    async def create_group_chat(
        self,
        participants: list[str],
        name: str | None = None,
        message: str | None = None,
    ) -> BlueBubblesChat:
        """Creates a new group chat."""
        body: dict[str, Any] = {"participants": participants}
        if name:
            body["name"] = name
        if message:
            body["message"] = message

        data = await self._post("/api/v1/chat", body)
        return BlueBubblesChat(**data)
