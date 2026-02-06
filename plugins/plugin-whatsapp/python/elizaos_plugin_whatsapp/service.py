"""WhatsApp service implementation."""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from elizaos.types.service import Service

from elizaos_plugin_whatsapp.client import WhatsAppClient
from elizaos_plugin_whatsapp.config import WhatsAppConfig, get_config_from_env
from elizaos_plugin_whatsapp.types import (
    IncomingMessage,
    WhatsAppChatState,
    WhatsAppMessageResponse,
    WhatsAppWebhookEvent,
)

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

logger = logging.getLogger(__name__)

WHATSAPP_SERVICE_NAME = "whatsapp"


class WhatsAppService(Service):
    """WhatsApp service for ElizaOS."""

    service_type = WHATSAPP_SERVICE_NAME

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        """Initializes the service."""
        super().__init__(runtime)
        self.client: WhatsAppClient | None = None
        self.config: WhatsAppConfig | None = None
        self.chat_states: dict[str, WhatsAppChatState] = {}
        self._is_running = False

    @property
    def capability_description(self) -> str:
        return "The agent is able to send and receive messages via WhatsApp"

    @property
    def is_running(self) -> bool:
        """Returns whether the service is running."""
        return self._is_running

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> WhatsAppService:
        """Starts the service."""
        service = cls(runtime)
        config = get_config_from_env()
        service.config = config

        if not config:
            logger.warning(
                "WhatsApp configuration not available - service unavailable"
            )
            return service

        if not config.enabled:
            logger.info("WhatsApp plugin is disabled via configuration")
            return service

        service.client = WhatsAppClient(config)
        service._is_running = True

        logger.info("WhatsApp service started")
        return service

    async def stop(self) -> None:
        """Stops the service."""
        self._is_running = False
        if self.client:
            await self.client.close()
        logger.info("WhatsApp service stopped")

    async def send_message(self, to: str, text: str) -> WhatsAppMessageResponse:
        """Sends a text message."""
        if not self.client:
            raise RuntimeError("WhatsApp client not initialized")

        return await self.client.send_text(to, text)

    async def handle_webhook(self, event: WhatsAppWebhookEvent) -> None:
        """Handles a webhook event."""
        for entry in event.entry:
            for change in entry.changes:
                if change.field == "messages":
                    if change.value.messages:
                        for message in change.value.messages:
                            await self._handle_incoming_message(
                                message, change.value.metadata.phone_number_id
                            )

                    if change.value.contacts:
                        for contact in change.value.contacts:
                            state = WhatsAppChatState(
                                phone_number_id=change.value.metadata.phone_number_id,
                                contact_wa_id=contact.wa_id,
                                contact_name=contact.profile.name,
                                last_message_at=int(time.time()),
                            )
                            self.chat_states[contact.wa_id] = state

    async def _handle_incoming_message(
        self, message: IncomingMessage, phone_number_id: str
    ) -> None:
        """Handles an incoming message."""
        logger.info(
            "Received message from %s (type: %s)", message.from_, message.type
        )

        if message.text:
            logger.debug("Message text: %s", message.text.body)

        # Update chat state
        state = WhatsAppChatState(
            phone_number_id=phone_number_id,
            contact_wa_id=message.from_,
            contact_name=None,
            last_message_at=int(message.timestamp),
        )
        self.chat_states[message.from_] = state

    def verify_webhook(self, token: str) -> bool:
        """Verifies a webhook token."""
        if not self.client:
            return False
        return self.client.verify_webhook(token)

    def get_chat_state(self, wa_id: str) -> WhatsAppChatState | None:
        """Gets chat state for a contact."""
        return self.chat_states.get(wa_id)
