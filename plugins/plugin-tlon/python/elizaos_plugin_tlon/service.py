"""Tlon service implementation."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from elizaos_plugin_tlon.client import TlonClient
from elizaos_plugin_tlon.config import (
    TlonConfig,
    format_ship,
    normalize_ship,
    parse_channel_nest,
)
from elizaos_plugin_tlon.error import ClientNotInitializedError, MessageSendError
from elizaos_plugin_tlon.types import (
    TlonChannelType,
    TlonChat,
    TlonEventType,
    TlonMessagePayload,
    TlonShip,
    TlonStory,
)

logger = logging.getLogger(__name__)


def extract_message_text(content: Any) -> str:
    """Extract plain text from Tlon story/content format."""
    if not content:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for verse in content:
            if isinstance(verse, str):
                parts.append(verse)
            elif isinstance(verse, dict):
                if "inline" in verse:
                    for inline in verse["inline"]:
                        if isinstance(inline, str):
                            parts.append(inline)
                        elif isinstance(inline, dict):
                            if "ship" in inline:
                                parts.append(format_ship(inline["ship"]))
                            elif "link" in inline:
                                parts.append(
                                    f"[{inline['link'].get('content', '')}]"
                                    f"({inline['link'].get('href', '')})"
                                )
                            elif "code" in inline:
                                parts.append(f"`{inline['code']}`")
        return " ".join(parts).strip()

    return str(content)


class TlonService:
    """Tlon service for managing Urbit connections."""

    def __init__(self, config: TlonConfig) -> None:
        """Initialize the service.

        Args:
            config: The service configuration
        """
        self.config = config
        self._client: TlonClient | None = None
        self._is_running = False
        self._subscribed_channels: set[str] = set()
        self._subscribed_dms: set[str] = set()
        self._processed_messages: dict[str, int] = {}
        self._max_processed_messages = 2000
        self._message_handlers: list[Callable[[TlonMessagePayload], None]] = []
        self._event_handlers: dict[TlonEventType, list[Callable[..., None]]] = {}

    @property
    def is_running(self) -> bool:
        """Whether the service is running."""
        return self._is_running

    @property
    def client(self) -> TlonClient | None:
        """The underlying Tlon client."""
        return self._client

    def on_message(self, handler: Callable[[TlonMessagePayload], None]) -> None:
        """Register a message handler."""
        self._message_handlers.append(handler)

    def on_event(self, event_type: TlonEventType, handler: Callable[..., None]) -> None:
        """Register an event handler."""
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def start(self) -> None:
        """Start the Tlon service."""
        if self._is_running:
            logger.warning("[Tlon] Service is already running")
            return

        if not self.config.enabled:
            logger.info("[Tlon] Plugin is disabled")
            return

        logger.info(f"[Tlon] Starting service for ~{self.config.ship}")

        self._client = await TlonClient.create(
            self.config.url,
            self.config.code,
            ship=self.config.ship,
        )

        await self._initialize_subscriptions()
        await self._client.connect()

        self._is_running = True
        self._emit_event(TlonEventType.WORLD_CONNECTED, {"ship": self.config.ship})

        logger.info("[Tlon] Service started successfully")

    async def stop(self) -> None:
        """Stop the Tlon service."""
        if not self._is_running:
            return

        logger.info("[Tlon] Stopping service...")

        if self._client:
            await self._client.close()
            self._client = None

        self._is_running = False
        self._subscribed_channels.clear()
        self._subscribed_dms.clear()
        self._processed_messages.clear()

        self._emit_event(TlonEventType.WORLD_LEFT, {"ship": self.config.ship})
        logger.info("[Tlon] Service stopped")

    async def _initialize_subscriptions(self) -> None:
        """Initialize subscriptions to channels and DMs."""
        if not self._client:
            return

        # Discover DMs
        try:
            dm_list = await self._client.scry("/chat/dm.json")
            if isinstance(dm_list, list):
                logger.info(f"[Tlon] Found {len(dm_list)} DM conversation(s)")
                for dm_ship in dm_list:
                    await self._subscribe_to_dm(dm_ship)
        except Exception as e:
            logger.warning(f"[Tlon] Failed to fetch DM list: {e}")

        # Subscribe to channels
        channels = list(self.config.group_channels)

        if self.config.auto_discover_channels:
            try:
                discovered = await self._discover_channels()
                if discovered:
                    channels = discovered
            except Exception as e:
                logger.warning(f"[Tlon] Auto-discovery failed: {e}")

        for channel_nest in channels:
            await self._subscribe_to_channel(channel_nest)

        logger.info(
            f"[Tlon] Subscribed to {len(self._subscribed_dms)} DMs "
            f"and {len(self._subscribed_channels)} channels"
        )

    async def _discover_channels(self) -> list[str]:
        """Discover available channels."""
        if not self._client:
            return []

        try:
            channels = await self._client.scry("/channels/channels.json")
            if isinstance(channels, dict):
                return list(channels.keys())
        except Exception:
            pass
        return []

    async def _subscribe_to_dm(self, dm_ship: str) -> None:
        """Subscribe to a DM conversation."""
        ship = normalize_ship(dm_ship)
        if ship in self._subscribed_dms or not self._client:
            return

        path = f"/dm/{ship}"
        await self._client.subscribe(
            app="chat",
            path=path,
            event=lambda data: self._handle_dm_event(ship, data),
            err=lambda e: logger.error(f"[Tlon] DM subscription error for {ship}: {e}"),
            quit=lambda: self._subscribed_dms.discard(ship),
        )

        self._subscribed_dms.add(ship)
        logger.debug(f"[Tlon] Subscribed to DM with {ship}")

    async def _subscribe_to_channel(self, channel_nest: str) -> None:
        """Subscribe to a group channel."""
        if channel_nest in self._subscribed_channels or not self._client:
            return

        parsed = parse_channel_nest(channel_nest)
        if not parsed:
            logger.error(f"[Tlon] Invalid channel format: {channel_nest}")
            return

        path = f"/{channel_nest}"
        await self._client.subscribe(
            app="channels",
            path=path,
            event=lambda data: self._handle_channel_event(channel_nest, data),
            err=lambda e: logger.error(
                f"[Tlon] Channel subscription error for {channel_nest}: {e}"
            ),
            quit=lambda: self._subscribed_channels.discard(channel_nest),
        )

        self._subscribed_channels.add(channel_nest)
        logger.debug(f"[Tlon] Subscribed to channel: {channel_nest}")

    def _mark_message_processed(self, message_id: str | None) -> bool:
        """Mark a message as processed, returns True if not already processed."""
        if not message_id:
            return True

        if message_id in self._processed_messages:
            return False

        self._processed_messages[message_id] = int(time.time() * 1000)

        # Cleanup old messages
        if len(self._processed_messages) > self._max_processed_messages:
            sorted_items = sorted(self._processed_messages.items(), key=lambda x: x[1])
            to_remove = len(self._processed_messages) - self._max_processed_messages + 100
            for msg_id, _ in sorted_items[:to_remove]:
                del self._processed_messages[msg_id]

        return True

    def _handle_dm_event(self, dm_ship: str, update: Any) -> None:
        """Handle an incoming DM event."""
        try:
            memo = update.get("response", {}).get("add", {}).get("memo")
            if not memo:
                return

            message_id = update.get("id")
            if not self._mark_message_processed(message_id):
                return

            sender_ship = normalize_ship(memo.get("author", ""))
            if not sender_ship or sender_ship == self.config.ship:
                return

            message_text = extract_message_text(memo.get("content"))
            if not message_text:
                return

            # Check DM allowlist
            if not self.config.is_dm_allowed(sender_ship):
                logger.debug(f"[Tlon] Blocked DM from {sender_ship}: not in allowlist")
                return

            payload = TlonMessagePayload(
                message_id=message_id or f"dm-{int(time.time() * 1000)}",
                chat=TlonChat.dm(sender_ship),
                from_ship=TlonShip(name=sender_ship),
                text=message_text,
                timestamp=memo.get("sent", int(time.time() * 1000)),
                raw_content=memo.get("content"),
            )

            self._emit_message(payload)
        except Exception as e:
            logger.error(f"[Tlon] Error handling DM event: {e}")

    def _handle_channel_event(self, channel_nest: str, update: Any) -> None:
        """Handle an incoming channel event."""
        try:
            response = update.get("response", {}).get("post", {})
            r_post = response.get("r-post", {})

            essay = r_post.get("set", {}).get("essay")
            reply_data = r_post.get("reply", {})
            memo = reply_data.get("r-reply", {}).get("set", {}).get("memo")

            if not essay and not memo:
                return

            content = memo or essay
            is_thread_reply = bool(memo)
            message_id = reply_data.get("id") if is_thread_reply else response.get("id")

            if not self._mark_message_processed(message_id):
                return

            sender_ship = normalize_ship(content.get("author", ""))
            if not sender_ship or sender_ship == self.config.ship:
                return

            message_text = extract_message_text(content.get("content"))
            if not message_text:
                return

            parsed = parse_channel_nest(channel_nest)
            if not parsed:
                return

            _, host_ship, channel_name = parsed

            # Get parent ID for thread replies
            seal = (
                reply_data.get("r-reply", {}).get("set", {}).get("seal")
                if is_thread_reply
                else r_post.get("set", {}).get("seal")
            )
            parent_id = seal.get("parent-id") or seal.get("parent") if seal else None

            chat_type = TlonChannelType.THREAD if is_thread_reply else TlonChannelType.GROUP
            payload = TlonMessagePayload(
                message_id=message_id or f"channel-{int(time.time() * 1000)}",
                chat=TlonChat(
                    id=channel_nest,
                    type=chat_type,
                    name=channel_name,
                    host_ship=host_ship,
                ),
                from_ship=TlonShip(name=sender_ship),
                text=message_text,
                timestamp=content.get("sent", int(time.time() * 1000)),
                reply_to_id=parent_id,
                raw_content=content.get("content"),
            )

            self._emit_message(payload)
        except Exception as e:
            logger.error(f"[Tlon] Error handling channel event: {e}")

    def _emit_message(self, payload: TlonMessagePayload) -> None:
        """Emit a message to handlers."""
        for handler in self._message_handlers:
            try:
                handler(payload)
            except Exception as e:
                logger.error(f"[Tlon] Error in message handler: {e}")

        event_type = (
            TlonEventType.DM_RECEIVED
            if payload.chat.type == TlonChannelType.DM
            else TlonEventType.GROUP_MESSAGE_RECEIVED
        )
        self._emit_event(event_type, payload)
        self._emit_event(TlonEventType.MESSAGE_RECEIVED, payload)

    def _emit_event(self, event_type: TlonEventType, payload: Any) -> None:
        """Emit an event to handlers."""
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception as e:
                logger.error(f"[Tlon] Error in event handler for {event_type}: {e}")

    async def send_dm(self, to_ship: str, text: str) -> str:
        """Send a direct message.

        Args:
            to_ship: The recipient ship
            text: The message text

        Returns:
            The message ID
        """
        if not self._client:
            raise ClientNotInitializedError()

        to = normalize_ship(to_ship)
        from_ship = self.config.ship

        sent_at = int(time.time() * 1000)
        msg_id = f"{format_ship(from_ship)}/{sent_at}"

        story: TlonStory = [{"inline": [text]}]
        delta = {
            "add": {
                "memo": {
                    "content": story,
                    "author": format_ship(from_ship),
                    "sent": sent_at,
                },
                "kind": None,
                "time": None,
            }
        }

        action = {
            "ship": format_ship(to),
            "diff": {"id": msg_id, "delta": delta},
        }

        try:
            await self._client.poke("chat", "chat-dm-action", action)
        except Exception as e:
            raise MessageSendError(to, e) from e

        return msg_id

    async def send_channel_message(
        self,
        channel_nest: str,
        text: str,
        reply_to_id: str | None = None,
    ) -> str:
        """Send a message to a group channel.

        Args:
            channel_nest: The channel nest string
            text: The message text
            reply_to_id: Optional parent message ID for thread replies

        Returns:
            The message ID
        """
        if not self._client:
            raise ClientNotInitializedError()

        parsed = parse_channel_nest(channel_nest)
        if not parsed:
            raise ValueError(f"Invalid channel nest: {channel_nest}")

        from_ship = self.config.ship
        sent_at = int(time.time() * 1000)

        story: TlonStory = [{"inline": [text]}]

        if reply_to_id:
            action_content = {
                "post": {
                    "reply": {
                        "id": reply_to_id,
                        "action": {
                            "add": {
                                "content": story,
                                "author": format_ship(from_ship),
                                "sent": sent_at,
                            }
                        },
                    }
                }
            }
        else:
            action_content = {
                "post": {
                    "add": {
                        "content": story,
                        "author": format_ship(from_ship),
                        "sent": sent_at,
                        "kind": "/chat",
                        "blob": None,
                        "meta": None,
                    }
                }
            }

        action = {"channel": {"nest": channel_nest, "action": action_content}}

        try:
            await self._client.poke("channels", "channel-action-1", action)
        except Exception as e:
            raise MessageSendError(channel_nest, e) from e

        return f"{format_ship(from_ship)}/{sent_at}"
