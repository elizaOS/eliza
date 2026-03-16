"""BlueBubbles service implementation."""

import logging
from typing import Any

from elizaos_plugin_bluebubbles.client import BlueBubblesClient
from elizaos_plugin_bluebubbles.config import (
    BlueBubblesConfig,
    get_config_from_env,
    is_group_handle_allowed,
    is_handle_allowed,
)
from elizaos_plugin_bluebubbles.types import (
    BlueBubblesChat,
    BlueBubblesChatState,
    BlueBubblesMessage,
    BlueBubblesWebhookPayload,
)

logger = logging.getLogger(__name__)

BLUEBUBBLES_SERVICE_NAME = "bluebubbles"


class BlueBubblesService:
    """BlueBubbles service for elizaOS."""

    service_type = BLUEBUBBLES_SERVICE_NAME
    capability_description = (
        "The agent is able to send and receive iMessages via BlueBubbles"
    )

    def __init__(self) -> None:
        """Initializes the service."""
        self.client: BlueBubblesClient | None = None
        self.config: BlueBubblesConfig | None = None
        self.known_chats: dict[str, BlueBubblesChat] = {}
        self._is_running = False

    @property
    def is_running(self) -> bool:
        """Returns whether the service is running."""
        return self._is_running

    @property
    def webhook_path(self) -> str:
        """Returns the webhook path."""
        if self.config:
            return self.config.webhook_path
        return "/webhooks/bluebubbles"

    async def start(self, runtime: Any = None) -> "BlueBubblesService":
        """Starts the service."""
        self.config = get_config_from_env()

        if not self.config:
            logger.warning(
                "BlueBubbles configuration not available - service unavailable"
            )
            return self

        if not self.config.enabled:
            logger.info("BlueBubbles plugin is disabled via configuration")
            return self

        self.client = BlueBubblesClient(self.config)

        # Probe the server
        probe_result = await self.client.probe()

        if not probe_result.ok:
            logger.error(
                "Failed to connect to BlueBubbles server: %s", probe_result.error
            )
            return self

        logger.info(
            "Connected to BlueBubbles server v%s on macOS %s",
            probe_result.server_version,
            probe_result.os_version,
        )

        if probe_result.private_api_enabled:
            logger.info(
                "BlueBubbles Private API enabled - edit and unsend available"
            )

        # Load initial chats
        try:
            chats = await self.client.list_chats(100)
            for chat in chats:
                self.known_chats[chat.guid] = chat
            logger.info("Loaded %d BlueBubbles chats", len(self.known_chats))
        except Exception as e:
            logger.warning("Failed to load initial chats: %s", e)

        self._is_running = True
        logger.info("BlueBubbles service started")

        return self

    async def stop(self, runtime: Any = None) -> None:
        """Stops the service."""
        self._is_running = False
        if self.client:
            await self.client.close()
        logger.info("BlueBubbles service stopped")

    async def handle_webhook(self, payload: BlueBubblesWebhookPayload) -> None:
        """Handles an incoming webhook payload."""
        if not self.config or not self.client:
            logger.warning("Webhook received but service not configured")
            return

        event_type = payload.type

        if event_type == "new-message":
            message = BlueBubblesMessage(**payload.data)
            await self._handle_incoming_message(message)
        elif event_type == "updated-message":
            message = BlueBubblesMessage(**payload.data)
            await self._handle_message_update(message)
        elif event_type == "chat-updated":
            chat = BlueBubblesChat(**payload.data)
            await self._handle_chat_update(chat)
        elif event_type in ("typing-indicator", "read-receipt"):
            logger.debug("BlueBubbles %s: %s", event_type, payload.data)
        else:
            logger.debug("Unhandled BlueBubbles event: %s", event_type)

    async def _handle_incoming_message(self, message: BlueBubblesMessage) -> None:
        """Handles an incoming message."""
        if not self.config:
            return

        # Skip outgoing messages
        if message.is_from_me:
            return

        # Skip system messages
        if message.is_system_message:
            return

        if not message.chats:
            logger.warning("Message without chat info: %s", message.guid)
            return

        chat = message.chats[0]
        is_group = len(chat.participants) > 1
        sender_handle = message.handle.address if message.handle else ""

        # Check access policies
        if is_group:
            if not is_group_handle_allowed(
                sender_handle,
                self.config.group_allow_from,
                self.config.group_policy,
            ):
                logger.debug("Ignoring from %s - not in group allowlist", sender_handle)
                return
        else:
            if not is_handle_allowed(
                sender_handle, self.config.allow_from, self.config.dm_policy
            ):
                logger.debug("Ignoring from %s - not in DM allowlist", sender_handle)
                return

        # Mark as read if configured
        if self.config.send_read_receipts and self.client:
            try:
                await self.client.mark_chat_read(chat.guid)
            except Exception as e:
                logger.debug("Failed to mark chat as read: %s", e)

        logger.info(
            "Received message from %s in chat %s: %s",
            sender_handle,
            chat.guid,
            message.text or "[no text]",
        )

    async def _handle_message_update(self, message: BlueBubblesMessage) -> None:
        """Handles a message update."""
        if message.date_edited:
            logger.debug("Message %s was edited", message.guid)

    async def _handle_chat_update(self, chat: BlueBubblesChat) -> None:
        """Handles a chat update."""
        logger.debug(
            "Chat %s updated: %s",
            chat.guid,
            chat.display_name or chat.chat_identifier,
        )
        self.known_chats[chat.guid] = chat

    async def send_message(
        self, target: str, text: str, reply_to_id: str | None = None
    ) -> str:
        """Sends a message to a target."""
        if not self.client:
            raise RuntimeError("BlueBubbles client not initialized")

        chat_guid = await self.client.resolve_target(target)
        result = await self.client.send_message(chat_guid, text)

        return result.guid

    async def get_chat_state(self, chat_guid: str) -> BlueBubblesChatState | None:
        """Gets the state for a chat."""
        chat = self.known_chats.get(chat_guid)

        if not chat and self.client:
            try:
                chat = await self.client.get_chat(chat_guid)
                self.known_chats[chat.guid] = chat
            except Exception:
                return None

        if not chat:
            return None

        return self._chat_to_state(chat)

    def _chat_to_state(self, chat: BlueBubblesChat) -> BlueBubblesChatState:
        """Converts a chat to a chat state."""
        return BlueBubblesChatState(
            chat_guid=chat.guid,
            chat_identifier=chat.chat_identifier,
            is_group=len(chat.participants) > 1,
            participants=[p.address for p in chat.participants],
            display_name=chat.display_name,
            last_message_at=(
                chat.last_message.date_created if chat.last_message else None
            ),
            has_unread=chat.has_unread_messages,
        )
