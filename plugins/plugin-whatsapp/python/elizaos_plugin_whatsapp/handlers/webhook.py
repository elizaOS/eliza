"""Webhook handler for WhatsApp plugin."""
import logging
from collections.abc import Callable

from elizaos_plugin_whatsapp.client import WhatsAppClient
from elizaos_plugin_whatsapp.types import (
    WhatsAppEventType,
    WhatsAppIncomingMessage,
    WhatsAppStatusUpdate,
    WhatsAppWebhookEvent,
)

logger = logging.getLogger(__name__)


class WebhookHandler:
    """Handler for WhatsApp webhook events."""

    def __init__(self, client: WhatsAppClient):
        """Initialize the webhook handler.

        Args:
            client: WhatsApp client instance.
        """
        self.client = client
        self._message_handlers: list[Callable[[WhatsAppIncomingMessage], None]] = []
        self._status_handlers: list[Callable[[WhatsAppStatusUpdate], None]] = []
        self._event_handlers: dict[WhatsAppEventType, list[Callable]] = {}

    def on_message(self, handler: Callable[[WhatsAppIncomingMessage], None]) -> None:
        """Register a handler for incoming messages.

        Args:
            handler: Function to call when a message is received.
        """
        self._message_handlers.append(handler)

    def on_status(self, handler: Callable[[WhatsAppStatusUpdate], None]) -> None:
        """Register a handler for status updates.

        Args:
            handler: Function to call when a status update is received.
        """
        self._status_handlers.append(handler)

    def on_event(self, event_type: WhatsAppEventType, handler: Callable) -> None:
        """Register a handler for a specific event type.

        Args:
            event_type: Type of event to handle.
            handler: Function to call when the event occurs.
        """
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    async def handle(self, event: WhatsAppWebhookEvent) -> None:
        """Handle a webhook event.

        Args:
            event: Webhook event from WhatsApp.
        """
        if event.object != "whatsapp_business_account":
            logger.warning("Received non-WhatsApp webhook event: %s", event.object)
            return

        for entry in event.entry:
            for change in entry.changes:
                if change.field != "messages":
                    continue

                value = change.value

                # Handle incoming messages
                if value.messages:
                    for message in value.messages:
                        await self._handle_message(message)

                # Handle status updates
                if value.statuses:
                    for status in value.statuses:
                        await self._handle_status(status)

    async def _handle_message(self, message: WhatsAppIncomingMessage) -> None:
        """Handle an incoming message.

        Args:
            message: The incoming message.
        """
        logger.info(
            "Received message from %s, type=%s, id=%s",
            message.from_,
            message.type,
            message.id,
        )

        # Determine event type based on message type
        if message.reaction:
            event_type = WhatsAppEventType.REACTION_RECEIVED
        elif message.interactive:
            event_type = WhatsAppEventType.INTERACTIVE_REPLY
        else:
            event_type = WhatsAppEventType.MESSAGE_RECEIVED

        # Call registered handlers
        for handler in self._message_handlers:
            try:
                handler(message)
            except Exception:
                logger.exception("Error in message handler")

        # Emit typed event
        self._emit_event(event_type, message)

    async def _handle_status(self, status: WhatsAppStatusUpdate) -> None:
        """Handle a status update.

        Args:
            status: The status update.
        """
        logger.debug(
            "Status update: message_id=%s, status=%s",
            status.id,
            status.status,
        )

        # Call registered handlers
        for handler in self._status_handlers:
            try:
                handler(status)
            except Exception:
                logger.exception("Error in status handler")

        # Emit typed event based on status
        event_type_map = {
            "sent": WhatsAppEventType.MESSAGE_SENT,
            "delivered": WhatsAppEventType.MESSAGE_DELIVERED,
            "read": WhatsAppEventType.MESSAGE_READ,
            "failed": WhatsAppEventType.MESSAGE_FAILED,
        }

        event_type = event_type_map.get(status.status)
        if event_type:
            self._emit_event(event_type, status)

    def _emit_event(self, event_type: WhatsAppEventType, payload: object) -> None:
        """Emit an event to registered handlers.

        Args:
            event_type: Type of event.
            payload: Event payload.
        """
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in event handler for %s", event_type)

    def verify_webhook(self, mode: str, token: str, challenge: str) -> str | None:
        """Verify a webhook subscription request.

        Args:
            mode: The hub.mode parameter.
            token: The hub.verify_token parameter.
            challenge: The hub.challenge parameter.

        Returns:
            The challenge if verification succeeds, None otherwise.
        """
        if mode == "subscribe" and self.client.verify_webhook(token):
            logger.info("Webhook verified successfully")
            self._emit_event(WhatsAppEventType.WEBHOOK_VERIFIED, {"challenge": challenge})
            return challenge
        logger.warning("Webhook verification failed")
        return None
