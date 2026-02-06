import json
import logging
from collections.abc import Awaitable, Callable

from aiohttp import web

from elizaos_plugin_nextcloud_talk.client import (
    extract_webhook_headers,
    parse_webhook_payload,
    send_message,
    send_reaction,
    verify_signature,
)
from elizaos_plugin_nextcloud_talk.config import NextcloudTalkConfig
from elizaos_plugin_nextcloud_talk.error import MessageSendError, ServiceNotInitializedError
from elizaos_plugin_nextcloud_talk.types import (
    NextcloudTalkEventType,
    NextcloudTalkInboundMessage,
    NextcloudTalkRoom,
    NextcloudTalkWebhookPayload,
)

logger = logging.getLogger(__name__)


class NextcloudTalkService:
    """Nextcloud Talk webhook bot service."""

    def __init__(self, config: NextcloudTalkConfig) -> None:
        self.config = config
        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None
        self._running = False
        self._message_handlers: list[Callable[[NextcloudTalkInboundMessage], Awaitable[None]]] = []
        self._event_handlers: dict[
            NextcloudTalkEventType, list[Callable[..., Awaitable[None] | None]]
        ] = {}
        self._known_rooms: dict[str, NextcloudTalkRoom] = {}

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def base_url(self) -> str:
        return self.config.base_url

    async def start(self) -> None:
        """Start the webhook server."""
        if not self.config.enabled:
            logger.info("Nextcloud Talk plugin is disabled via configuration")
            return

        self.config.validate_config()

        logger.info("Starting Nextcloud Talk service...")

        self._app = web.Application()
        self._app.router.add_post(self.config.webhook_path, self._handle_webhook)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()

        site = web.TCPSite(
            self._runner,
            self.config.webhook_host,
            self.config.webhook_port,
        )
        await site.start()

        self._running = True
        logger.info(
            f"Nextcloud Talk service started on "
            f"{self.config.webhook_host}:{self.config.webhook_port}{self.config.webhook_path}"
        )

        self._emit_event(
            NextcloudTalkEventType.WORLD_CONNECTED,
            {
                "base_url": self.config.base_url,
                "webhook_port": self.config.webhook_port,
                "webhook_path": self.config.webhook_path,
            },
        )

    async def stop(self) -> None:
        """Stop the webhook server."""
        if self._runner and self._running:
            logger.info("Stopping Nextcloud Talk service...")
            await self._runner.cleanup()
            self._running = False
            logger.info("Nextcloud Talk service stopped")

    def on_message(
        self, handler: Callable[[NextcloudTalkInboundMessage], Awaitable[None]]
    ) -> None:
        """Register a message handler."""
        self._message_handlers.append(handler)

    def on_event(
        self,
        event_type: NextcloudTalkEventType,
        handler: Callable[..., Awaitable[None] | None],
    ) -> None:
        """Register an event handler."""
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def send_message_to_room(
        self,
        room_token: str,
        text: str,
        reply_to: str | None = None,
    ) -> str:
        """Send a message to a room and return the message ID."""
        try:
            result = await send_message(
                self.config.base_url,
                self.config.bot_secret,
                room_token,
                text,
                reply_to,
            )

            self._emit_event(
                NextcloudTalkEventType.MESSAGE_SENT,
                {
                    "room_token": room_token,
                    "message_id": result.message_id,
                    "text": text,
                },
            )

            return result.message_id
        except Exception as e:
            raise MessageSendError(room_token, e) from e

    async def send_reaction_to_message(
        self,
        room_token: str,
        message_id: str,
        reaction: str,
    ) -> None:
        """Send a reaction to a message."""
        await send_reaction(
            self.config.base_url,
            self.config.bot_secret,
            room_token,
            message_id,
            reaction,
        )

        self._emit_event(
            NextcloudTalkEventType.REACTION_SENT,
            {
                "room_token": room_token,
                "message_id": message_id,
                "reaction": reaction,
            },
        )

    def get_room(self, token: str) -> NextcloudTalkRoom | None:
        """Get information about a known room."""
        return self._known_rooms.get(token)

    async def _handle_webhook(self, request: web.Request) -> web.Response:
        """Handle incoming webhook requests."""
        try:
            # Read body
            body_bytes = await request.read()
            body_str = body_bytes.decode("utf-8")

            # Extract headers
            headers_dict = {k: v for k, v in request.headers.items()}
            webhook_headers = extract_webhook_headers(headers_dict)

            if not webhook_headers:
                return web.Response(status=400, text="Missing required headers")

            # Verify signature
            if not verify_signature(
                webhook_headers.signature,
                webhook_headers.random,
                body_str,
                self.config.bot_secret,
            ):
                logger.warning("Invalid webhook signature")
                return web.Response(status=401, text="Invalid signature")

            # Parse payload
            try:
                payload_dict = json.loads(body_str)
                payload = NextcloudTalkWebhookPayload.model_validate(payload_dict)
            except Exception as e:
                logger.warning(f"Failed to parse webhook payload: {e}")
                return web.Response(status=400, text="Invalid payload")

            # Only handle "Create" events (new messages)
            if payload.type != "Create":
                return web.Response(status=200, text="OK")

            # Check room allowlist
            if not self.config.is_room_allowed(payload.target.id):
                logger.debug(f"Dropping message from non-allowed room: {payload.target.id}")
                return web.Response(status=200, text="OK")

            # Parse message
            message = parse_webhook_payload(payload)

            # Emit event
            self._emit_event(
                NextcloudTalkEventType.MESSAGE_RECEIVED,
                message.model_dump(),
            )

            # Call message handlers
            for handler in self._message_handlers:
                try:
                    await handler(message)
                except Exception:
                    logger.exception("Error in message handler")

            return web.Response(status=200, text="OK")

        except Exception:
            logger.exception("Error handling webhook")
            return web.Response(status=500, text="Internal server error")

    def _emit_event(
        self,
        event_type: NextcloudTalkEventType,
        payload: object,
    ) -> None:
        """Emit an event to registered handlers."""
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                result = handler(payload)
                # Handle async handlers
                if hasattr(result, "__await__"):
                    import asyncio

                    asyncio.create_task(result)
            except Exception:
                logger.exception(f"Error in event handler for {event_type}")
