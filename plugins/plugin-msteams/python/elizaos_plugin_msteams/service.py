"""MS Teams service implementation."""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from aiohttp import web

from elizaos_plugin_msteams.client import MSTeamsClient
from elizaos_plugin_msteams.config import MSTeamsConfig
from elizaos_plugin_msteams.types import (
    ConversationType,
    MSTeamsConversation,
    MSTeamsConversationReference,
    MSTeamsEventType,
    MSTeamsMessagePayload,
    MSTeamsSendResult,
    MSTeamsUser,
)

logger = logging.getLogger(__name__)

# Type alias for event callback
EventCallback = Callable[[MSTeamsEventType, dict[str, Any]], Awaitable[None] | None]


class MSTeamsService:
    """MS Teams service for elizaOS."""

    def __init__(self, config: MSTeamsConfig) -> None:
        """Initialize the service with configuration."""
        self.config = config
        self.client = MSTeamsClient(config)
        self._is_running = False
        self._event_callback: EventCallback | None = None
        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None

    @property
    def is_running(self) -> bool:
        """Returns whether the service is currently running."""
        return self._is_running

    def set_event_callback(self, callback: EventCallback) -> None:
        """Set a callback invoked for each emitted event."""
        self._event_callback = callback

    async def _emit_event(
        self, event_type: MSTeamsEventType, payload: dict[str, Any]
    ) -> None:
        """Emit an event to the callback if set."""
        if self._event_callback:
            result = self._event_callback(event_type, payload)
            if asyncio.iscoroutine(result):
                await result

    async def start(self) -> None:
        """Start the MS Teams webhook server."""
        if self._is_running:
            raise RuntimeError("Service is already running")

        self.config.validate_config()

        logger.info("Starting MS Teams service...")

        self._is_running = True

        # Emit connected event
        await self._emit_event(
            MSTeamsEventType.WORLD_CONNECTED,
            {
                "app_id": self.config.app_id,
                "tenant_id": self.config.tenant_id,
            },
        )

        # Set up aiohttp web server
        self._app = web.Application()
        self._app.router.add_get("/health", self._handle_health)
        self._app.router.add_post(self.config.webhook_path, self._handle_webhook)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()

        site = web.TCPSite(self._runner, "0.0.0.0", self.config.webhook_port)
        await site.start()

        logger.info(
            f"MS Teams webhook server listening on port {self.config.webhook_port}"
        )

    async def stop(self) -> None:
        """Stop the MS Teams service."""
        logger.info("Stopping MS Teams service...")

        if self._runner:
            await self._runner.cleanup()
            self._runner = None

        self._is_running = False
        await self.client.close()

        logger.info("MS Teams service stopped")

    async def _handle_health(self, request: web.Request) -> web.Response:
        """Handle health check requests."""
        return web.json_response({"status": "ok", "service": "msteams"})

    async def _handle_webhook(self, request: web.Request) -> web.Response:
        """Handle incoming webhook requests from Bot Framework."""
        try:
            activity = await request.json()
            await self._process_activity(activity)
            return web.Response(status=200)
        except Exception:
            logger.exception("Failed to process webhook request")
            return web.Response(status=400, text="Bad request")

    async def _process_activity(self, activity: dict[str, Any]) -> None:
        """Process a Bot Framework activity."""
        activity_type = activity.get("type", "")

        # Extract conversation info
        conv_data = activity.get("conversation", {})
        conv_id = conv_data.get("id", "")
        conv_type_str = conv_data.get("conversationType", "personal")

        conv_type = {
            "groupChat": ConversationType.GROUP_CHAT,
            "channel": ConversationType.CHANNEL,
        }.get(conv_type_str, ConversationType.PERSONAL)

        tenant_id = conv_data.get("tenantId")
        service_url = activity.get("serviceUrl")

        # Validate tenant if configured
        if self.config.allowed_tenants and tenant_id:
            if not self.config.is_tenant_allowed(tenant_id):
                logger.debug(f"Ignoring activity from non-allowed tenant: {tenant_id}")
                return

        # Store conversation reference
        if conv_id and service_url:
            from_data = activity.get("from", {})
            recipient_data = activity.get("recipient", {})

            from_user = MSTeamsUser(
                id=from_data.get("id", ""),
                name=from_data.get("name"),
                aad_object_id=from_data.get("aadObjectId"),
            )

            bot_user = MSTeamsUser(
                id=recipient_data.get("id", ""),
                name=recipient_data.get("name"),
            )

            conv_ref = MSTeamsConversationReference(
                activity_id=activity.get("id"),
                user=from_user,
                bot=bot_user,
                conversation=MSTeamsConversation(
                    id=conv_id,
                    conversation_type=conv_type,
                    tenant_id=tenant_id,
                    name=conv_data.get("name"),
                    is_group=conv_type != ConversationType.PERSONAL,
                ),
                channel_id="msteams",
                service_url=service_url,
                locale=activity.get("locale"),
            )

            self.client.store_conversation_reference(conv_ref)

        # Handle by activity type
        if activity_type == "message":
            await self._handle_message(activity, conv_id, conv_type, tenant_id, service_url)
        elif activity_type == "conversationUpdate":
            await self._handle_conversation_update(activity, conv_id)
        elif activity_type == "messageReaction":
            await self._emit_event(MSTeamsEventType.REACTION_RECEIVED, activity)
        elif activity_type == "invoke":
            await self._handle_invoke(activity, conv_id)
        else:
            logger.debug(f"Unhandled activity type: {activity_type}")

    async def _handle_message(
        self,
        activity: dict[str, Any],
        conv_id: str,
        conv_type: ConversationType,
        tenant_id: str | None,
        service_url: str | None,
    ) -> None:
        """Handle a message activity."""
        text = activity.get("text", "")
        cleaned_text = MSTeamsClient.strip_mention_tags(text)

        if not cleaned_text:
            return

        from_data = activity.get("from", {})

        payload = MSTeamsMessagePayload(
            activity_id=activity.get("id", ""),
            conversation_id=conv_id,
            conversation_type=conv_type,
            from_user=MSTeamsUser(
                id=from_data.get("id", ""),
                name=from_data.get("name"),
            ),
            conversation=MSTeamsConversation(
                id=conv_id,
                conversation_type=conv_type,
                tenant_id=tenant_id,
                is_group=conv_type != ConversationType.PERSONAL,
            ),
            service_url=service_url or "",
            text=cleaned_text,
            timestamp=int(time.time()),
            reply_to_id=activity.get("replyToId"),
            channel_data=activity.get("channelData"),
        )

        await self._emit_event(
            MSTeamsEventType.MESSAGE_RECEIVED, payload.model_dump(by_alias=True)
        )

    async def _handle_conversation_update(
        self, activity: dict[str, Any], conv_id: str
    ) -> None:
        """Handle a conversation update activity."""
        members_added = activity.get("membersAdded", [])
        members_removed = activity.get("membersRemoved", [])

        for member in members_added:
            await self._emit_event(
                MSTeamsEventType.ENTITY_JOINED,
                {"user": member, "conversationId": conv_id},
            )

        for member in members_removed:
            await self._emit_event(
                MSTeamsEventType.ENTITY_LEFT,
                {"user": member, "conversationId": conv_id},
            )

    async def _handle_invoke(self, activity: dict[str, Any], conv_id: str) -> None:
        """Handle an invoke activity (card actions, etc.)."""
        await self._emit_event(
            MSTeamsEventType.CARD_ACTION_RECEIVED,
            {
                "activityId": activity.get("id"),
                "conversationId": conv_id,
                "from": activity.get("from"),
                "value": activity.get("value"),
            },
        )

    async def send_message(
        self, conversation_id: str, text: str
    ) -> MSTeamsSendResult:
        """Send a proactive message."""
        return await self.client.send_proactive_message(conversation_id, text)

    async def send_poll(
        self,
        conversation_id: str,
        question: str,
        options: list[str],
        max_selections: int = 1,
    ) -> tuple[MSTeamsSendResult, str]:
        """Send a poll."""
        return await self.client.send_poll(
            conversation_id, question, options, max_selections
        )

    async def send_adaptive_card(
        self,
        conversation_id: str,
        card: dict[str, Any],
        fallback_text: str | None = None,
    ) -> MSTeamsSendResult:
        """Send an Adaptive Card."""
        return await self.client.send_adaptive_card(
            conversation_id, card, fallback_text
        )
