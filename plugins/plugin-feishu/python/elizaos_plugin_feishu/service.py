import json
import logging
import time
from collections.abc import Callable

import httpx

from elizaos_plugin_feishu.config import FeishuConfig
from elizaos_plugin_feishu.error import (
    ApiError,
    AuthenticationError,
    BotNotInitializedError,
    MessageSendError,
)
from elizaos_plugin_feishu.types import (
    FeishuChat,
    FeishuChatType,
    FeishuContent,
    FeishuEventType,
    FeishuMessagePayload,
    FeishuUser,
)

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 4000


class FeishuService:
    """Feishu/Lark service for elizaOS."""

    def __init__(self, config: FeishuConfig) -> None:
        self.config = config
        self._client: httpx.AsyncClient | None = None
        self._running = False
        self._bot_open_id: str | None = None
        self._access_token: str | None = None
        self._token_expires_at: float = 0
        self._message_handlers: list[Callable[[FeishuMessagePayload], None]] = []
        self._event_handlers: dict[FeishuEventType, list[Callable[..., None]]] = {}

    @property
    def is_running(self) -> bool:
        """Returns whether the service is running."""
        return self._running

    @property
    def bot_open_id(self) -> str | None:
        """Returns the bot's open ID."""
        return self._bot_open_id

    async def _get_access_token(self) -> str:
        """Gets or refreshes the tenant access token."""
        if self._access_token and time.time() < self._token_expires_at - 60:
            return self._access_token

        if not self._client:
            raise BotNotInitializedError()

        url = f"{self.config.api_root}/open-apis/auth/v3/tenant_access_token/internal"

        response = await self._client.post(
            url,
            json={
                "app_id": self.config.app_id,
                "app_secret": self.config.app_secret,
            },
        )
        response.raise_for_status()

        data = response.json()
        if data.get("code") != 0:
            raise AuthenticationError(data.get("msg", "Authentication failed"))

        self._access_token = data.get("tenant_access_token")
        expire = data.get("expire", 7200)
        self._token_expires_at = time.time() + expire

        return self._access_token  # type: ignore[return-value]

    async def start(self) -> None:
        """Starts the Feishu service."""
        logger.info("Starting Feishu service...")

        valid, error = self.config.validate_config()
        if not valid:
            raise ValueError(f"Invalid configuration: {error}")

        self._client = httpx.AsyncClient(timeout=30.0)

        # Verify credentials by getting a token
        await self._get_access_token()

        # Get bot info
        bot_info = await self._get_bot_info()
        self._bot_open_id = bot_info.open_id

        self._running = True
        logger.info("Feishu service started successfully")

        self._emit_event(
            FeishuEventType.WORLD_CONNECTED,
            {"bot_open_id": self._bot_open_id, "bot_name": bot_info.name},
        )

    async def stop(self) -> None:
        """Stops the Feishu service."""
        if self._client and self._running:
            logger.info("Stopping Feishu service...")
            await self._client.aclose()
            self._client = None
            self._running = False
            self._access_token = None
            logger.info("Feishu service stopped")

    async def _get_bot_info(self) -> FeishuUser:
        """Gets bot information."""
        if not self._client:
            raise BotNotInitializedError()

        token = await self._get_access_token()
        url = f"{self.config.api_root}/open-apis/bot/v3/info"

        response = await self._client.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()

        data = response.json()
        if data.get("code") != 0:
            raise ApiError(data.get("code", -1), data.get("msg", "Unknown error"))

        bot_data = data.get("bot", {})
        return FeishuUser(
            open_id=bot_data.get("open_id", ""),
            name=bot_data.get("app_name"),
            is_bot=True,
        )

    def on_message(self, handler: Callable[[FeishuMessagePayload], None]) -> None:
        """Registers a message handler."""
        self._message_handlers.append(handler)

    def on_event(self, event_type: FeishuEventType, handler: Callable[..., None]) -> None:
        """Registers an event handler."""
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def send_message(
        self,
        chat_id: str,
        content: FeishuContent,
    ) -> list[str]:
        """Sends a message to a chat."""
        if not self._client:
            raise BotNotInitializedError()

        token = await self._get_access_token()
        url = f"{self.config.api_root}/open-apis/im/v1/messages"

        message_ids: list[str] = []

        try:
            # Handle different content types
            if content.card:
                msg_type = "interactive"
                msg_content = json.dumps(content.card)
                parts = [msg_content]
            elif content.image_key:
                msg_type = "image"
                msg_content = json.dumps({"image_key": content.image_key})
                parts = [msg_content]
            else:
                msg_type = "text"
                text = content.text or ""
                parts = self._split_message(text)

            for part in parts:
                if msg_type == "text":
                    body_content = json.dumps({"text": part})
                else:
                    body_content = part

                response = await self._client.post(
                    url,
                    params={"receive_id_type": "chat_id"},
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "receive_id": chat_id,
                        "msg_type": msg_type,
                        "content": body_content,
                    },
                )

                data = response.json()
                if data.get("code") != 0:
                    raise ApiError(data.get("code", -1), data.get("msg", "Unknown error"))

                message_id = data.get("data", {}).get("message_id")
                if message_id:
                    message_ids.append(message_id)

            return message_ids

        except httpx.HTTPError as e:
            raise MessageSendError(chat_id, e) from e

    async def reply_to_message(
        self,
        message_id: str,
        content: FeishuContent,
    ) -> list[str]:
        """Replies to a message."""
        if not self._client:
            raise BotNotInitializedError()

        token = await self._get_access_token()
        url = f"{self.config.api_root}/open-apis/im/v1/messages/{message_id}/reply"

        message_ids: list[str] = []
        text = content.text or ""
        parts = self._split_message(text)

        try:
            for part in parts:
                response = await self._client.post(
                    url,
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "msg_type": "text",
                        "content": json.dumps({"text": part}),
                    },
                )

                data = response.json()
                if data.get("code") != 0:
                    raise ApiError(data.get("code", -1), data.get("msg", "Unknown error"))

                msg_id = data.get("data", {}).get("message_id")
                if msg_id:
                    message_ids.append(msg_id)

            return message_ids

        except httpx.HTTPError as e:
            raise MessageSendError(message_id, e) from e

    async def get_chat(self, chat_id: str) -> FeishuChat:
        """Gets chat information."""
        if not self._client:
            raise BotNotInitializedError()

        token = await self._get_access_token()
        url = f"{self.config.api_root}/open-apis/im/v1/chats/{chat_id}"

        response = await self._client.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
        )

        data = response.json()
        if data.get("code") != 0:
            raise ApiError(data.get("code", -1), data.get("msg", "Unknown error"))

        chat_data = data.get("data", {})
        chat_mode = chat_data.get("chat_mode", "group")

        return FeishuChat(
            chat_id=chat_data.get("chat_id", chat_id),
            chat_type=FeishuChatType.P2P if chat_mode == "p2p" else FeishuChatType.GROUP,
            name=chat_data.get("name"),
            owner_open_id=chat_data.get("owner_id"),
            description=chat_data.get("description"),
            tenant_key=chat_data.get("tenant_key"),
        )

    async def handle_message_event(self, payload: FeishuMessagePayload) -> None:
        """Handles an incoming message event."""
        # Check if chat is allowed
        if not self.config.is_chat_allowed(payload.chat.chat_id):
            logger.debug("Chat %s not authorized, skipping", payload.chat.chat_id)
            return

        # Ignore bot messages if configured
        if payload.sender and self.config.should_ignore_bot_messages and payload.sender.is_bot:
            logger.debug("Ignoring bot message")
            return

        # Call message handlers
        for handler in self._message_handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in message handler")

        # Emit event
        self._emit_event(FeishuEventType.MESSAGE_RECEIVED, payload.model_dump())

    def _emit_event(self, event_type: FeishuEventType, payload: object) -> None:
        """Emits an event to registered handlers."""
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in event handler for %s", event_type)

    def _split_message(self, content: str) -> list[str]:
        """Splits a long message into chunks."""
        if len(content) <= MAX_MESSAGE_LENGTH:
            return [content]

        parts: list[str] = []
        current = ""

        for line in content.split("\n"):
            line_with_newline = f"\n{line}" if current else line

            if len(current) + len(line_with_newline) > MAX_MESSAGE_LENGTH:
                if current:
                    parts.append(current)
                    current = ""

                if len(line) > MAX_MESSAGE_LENGTH:
                    # Split long lines by words
                    words = line.split()
                    for word in words:
                        word_with_space = f" {word}" if current else word
                        if len(current) + len(word_with_space) > MAX_MESSAGE_LENGTH:
                            if current:
                                parts.append(current)
                                current = ""
                            if len(word) > MAX_MESSAGE_LENGTH:
                                # Split very long words
                                for i in range(0, len(word), MAX_MESSAGE_LENGTH):
                                    parts.append(word[i : i + MAX_MESSAGE_LENGTH])
                            else:
                                current = word
                        else:
                            current += word_with_space
                else:
                    current = line
            else:
                current += line_with_newline

        if current:
            parts.append(current)

        return parts
