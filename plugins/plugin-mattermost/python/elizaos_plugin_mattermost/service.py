from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

import websockets
from websockets import WebSocketClientProtocol

from elizaos_plugin_mattermost.client import MattermostClient, create_mattermost_client
from elizaos_plugin_mattermost.config import MattermostConfig
from elizaos_plugin_mattermost.types import (
    DmPolicy,
    GroupPolicy,
    MattermostChannel,
    MattermostContent,
    MattermostEventType,
    MattermostMessagePayload,
    MattermostPost,
    MattermostUser,
    get_channel_kind,
)

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 16383
WS_RECONNECT_DELAY_S = 2


class MattermostService:
    """Mattermost service for elizaOS."""

    def __init__(self, config: MattermostConfig) -> None:
        self.config = config
        self._client: MattermostClient | None = None
        self._bot_user: MattermostUser | None = None
        self._running = False
        self._ws: WebSocketClientProtocol | None = None
        self._ws_seq = 1
        self._message_handlers: list[Callable[[MattermostMessagePayload], None]] = []
        self._event_handlers: dict[MattermostEventType, list[Callable[..., None]]] = {}

    @property
    def client(self) -> MattermostClient:
        """Returns the Mattermost client."""
        if self._client is None:
            raise RuntimeError("Mattermost service not initialized")
        return self._client

    @property
    def bot_user(self) -> MattermostUser:
        """Returns the bot user."""
        if self._bot_user is None:
            raise RuntimeError("Mattermost service not initialized")
        return self._bot_user

    @property
    def is_running(self) -> bool:
        """Returns whether the service is running."""
        return self._running

    def on_message(self, handler: Callable[[MattermostMessagePayload], None]) -> None:
        """Register a message handler."""
        self._message_handlers.append(handler)

    def on_event(self, event_type: MattermostEventType, handler: Callable[..., None]) -> None:
        """Register an event handler."""
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def start(self) -> None:
        """Start the Mattermost service."""
        if not self.config.enabled:
            logger.info("Mattermost service is disabled")
            return

        logger.info("Starting Mattermost service...")

        self._client = create_mattermost_client(
            self.config.server_url,
            self.config.bot_token,
        )

        self._bot_user = await self._client.get_me()
        logger.info(
            "Mattermost connected as @%s",
            self._bot_user.username or self._bot_user.id,
        )

        self._running = True

        # Emit connected event
        self._emit_event(
            MattermostEventType.WORLD_CONNECTED,
            {
                "bot_id": self._bot_user.id,
                "bot_username": self._bot_user.username,
                "bot_name": self._bot_user.display_name(),
            },
        )

        # Start WebSocket connection in background
        asyncio.create_task(self._websocket_loop())

        logger.info("Mattermost service started successfully")

    async def stop(self) -> None:
        """Stop the Mattermost service."""
        logger.info("Stopping Mattermost service...")
        self._running = False
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._client:
            await self._client.close()
            self._client = None
        logger.info("Mattermost service stopped")

    async def _websocket_loop(self) -> None:
        """WebSocket connection loop with reconnection."""
        while self._running:
            try:
                await self._connect_websocket()
            except Exception as e:
                logger.error("WebSocket error: %s", e)
            if self._running:
                await asyncio.sleep(WS_RECONNECT_DELAY_S)

    async def _connect_websocket(self) -> None:
        """Connect to Mattermost WebSocket."""
        if not self._client:
            return

        ws_url = self._client.websocket_url()
        logger.info("Connecting to Mattermost WebSocket...")

        async with websockets.connect(ws_url) as ws:
            self._ws = ws

            # Authenticate
            auth_msg = json.dumps({
                "seq": self._ws_seq,
                "action": "authentication_challenge",
                "data": {"token": self.config.bot_token},
            })
            self._ws_seq += 1
            await ws.send(auth_msg)

            logger.info("Mattermost WebSocket connected")

            async for message in ws:
                if not self._running:
                    break
                try:
                    await self._handle_websocket_message(message)
                except Exception as e:
                    logger.error("Error handling WebSocket message: %s", e)

    async def _handle_websocket_message(self, message: str | bytes) -> None:
        """Handle a WebSocket message."""
        try:
            data = json.loads(message if isinstance(message, str) else message.decode("utf-8"))
        except json.JSONDecodeError:
            return

        event = data.get("event")
        if event != "posted":
            return

        post_data = data.get("data", {}).get("post")
        if not post_data:
            return

        try:
            post_dict = json.loads(post_data) if isinstance(post_data, str) else post_data
            post = MattermostPost.model_validate(post_dict)
            await self._handle_post(post, data)
        except Exception as e:
            logger.error("Error processing post: %s", e)

    async def _handle_post(self, post: MattermostPost, event_data: dict[str, Any]) -> None:
        """Handle an incoming post."""
        if not self._client or not self._bot_user:
            return

        # Ignore own messages
        if post.user_id == self._bot_user.id:
            return

        # Ignore system posts
        if post.is_system_post():
            return

        channel_id = post.channel_id
        if not channel_id:
            return

        # Fetch channel info
        try:
            channel = await self._client.get_channel(channel_id)
        except Exception as e:
            logger.warning("Failed to fetch channel %s: %s", channel_id, e)
            return

        kind = channel.kind()

        # Fetch sender info
        sender: MattermostUser | None = None
        if post.user_id:
            try:
                sender = await self._client.get_user(post.user_id)
            except Exception:
                pass

        # Check policies
        if not self._should_process_message(kind, post, sender):
            return

        # Check mention requirement for channels
        raw_text = post.message_text()
        if kind != "dm" and self.config.require_mention:
            if self._bot_user.username:
                mention = f"@{self._bot_user.username}"
                if mention.lower() not in raw_text.lower():
                    return

        # Ignore bot messages if configured
        if self.config.ignore_bot_messages and sender and sender.is_bot:
            return

        # Create payload
        payload = MattermostMessagePayload(
            post=post,
            channel=channel,
            user=sender,
            team=None,
        )

        # Call message handlers
        for handler in self._message_handlers:
            try:
                handler(payload)
            except Exception as e:
                logger.exception("Error in message handler: %s", e)

        # Emit event
        self._emit_event(MattermostEventType.MESSAGE_RECEIVED, payload)

    def _should_process_message(
        self,
        kind: str,
        post: MattermostPost,
        sender: MattermostUser | None,
    ) -> bool:
        """Check if the message should be processed based on policies."""
        user_id = post.user_id or ""
        username = sender.username if sender else None

        if kind == "dm":
            if self.config.dm_policy == DmPolicy.DISABLED:
                return False
            if self.config.dm_policy == DmPolicy.OPEN:
                return True
            return self.config.is_user_allowed(user_id, username)

        # Group or channel
        if self.config.group_policy == GroupPolicy.DISABLED:
            return False
        if self.config.group_policy == GroupPolicy.OPEN:
            return True
        return self.config.is_user_allowed(user_id, username)

    def _emit_event(self, event_type: MattermostEventType, payload: Any) -> None:
        """Emit an event to registered handlers."""
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception as e:
                logger.exception("Error in event handler for %s: %s", event_type, e)

    async def send_message(
        self,
        channel_id: str,
        content: MattermostContent,
    ) -> MattermostPost | None:
        """Send a message to a channel."""
        if not self._client:
            raise RuntimeError("Mattermost service not initialized")

        text = content.text or ""
        parts = split_message(text)

        last_post: MattermostPost | None = None
        for i, part in enumerate(parts):
            post = await self._client.create_post(
                channel_id=channel_id,
                message=part,
                root_id=content.root_id if i == 0 else None,
                file_ids=content.file_ids if i == 0 else None,
                props=content.props if i == 0 else None,
            )
            last_post = post

        if last_post:
            self._emit_event(
                MattermostEventType.MESSAGE_SENT,
                {"post": last_post, "channel_id": channel_id},
            )

        return last_post

    async def send_dm(self, user_id: str, content: MattermostContent) -> MattermostPost | None:
        """Send a direct message to a user."""
        if not self._client or not self._bot_user:
            raise RuntimeError("Mattermost service not initialized")

        channel = await self._client.create_direct_channel([self._bot_user.id, user_id])
        return await self.send_message(channel.id, content)

    async def send_typing(self, channel_id: str, parent_id: str | None = None) -> None:
        """Send a typing indicator."""
        if not self._client:
            raise RuntimeError("Mattermost service not initialized")
        await self._client.send_typing(channel_id, parent_id)


def split_message(content: str) -> list[str]:
    """Split a message into chunks that fit within the max length."""
    if len(content) <= MAX_MESSAGE_LENGTH:
        return [content]

    parts: list[str] = []
    current = ""

    for line in content.split("\n"):
        line_with_newline = line if not current else f"\n{line}"

        if len(current) + len(line_with_newline) > MAX_MESSAGE_LENGTH:
            if current:
                parts.append(current)
                current = ""

            if len(line) > MAX_MESSAGE_LENGTH:
                # Split long lines by words
                words = line.split()
                for word in words:
                    word_with_space = word if not current else f" {word}"
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
