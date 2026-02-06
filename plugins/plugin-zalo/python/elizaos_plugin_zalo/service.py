"""Native Zalo OA service implementation."""

import logging
import time
from collections.abc import Callable
from typing import Any

from elizaos_plugin_zalo.client import MAX_MESSAGE_LENGTH, ZaloClient
from elizaos_plugin_zalo.config import ZaloConfig
from elizaos_plugin_zalo.error import ClientNotInitializedError, MessageSendError
from elizaos_plugin_zalo.types import (
    ZaloBotProbe,
    ZaloBotStatusPayload,
    ZaloEventType,
    ZaloOAInfo,
    ZaloSendImageParams,
    ZaloSendMessageParams,
)

logger = logging.getLogger(__name__)


class ZaloService:
    """Zalo Official Account service."""

    def __init__(self, config: ZaloConfig) -> None:
        """Initialize the Zalo service.
        
        Args:
            config: Service configuration.
        """
        self.config = config
        self._client: ZaloClient | None = None
        self._running = False
        self._oa_info: ZaloOAInfo | None = None
        self._event_handlers: dict[ZaloEventType, list[Callable[..., None]]] = {}

    @property
    def is_running(self) -> bool:
        """Whether the service is running."""
        return self._running

    @property
    def oa_info(self) -> ZaloOAInfo | None:
        """OA information."""
        return self._oa_info

    async def start(self) -> None:
        """Start the Zalo service."""
        logger.info("Starting Zalo service...")

        self.config.validate_config()

        # Create client
        self._client = ZaloClient(
            self.config.access_token,
            proxy_url=self.config.proxy_url,
        )

        # Get OA info
        try:
            self._oa_info = await self._client.get_oa_info()
            logger.info("Connected to Zalo OA: %s (ID: %s)", self._oa_info.name, self._oa_info.oa_id)
        except Exception as e:
            logger.warning("Failed to get OA info: %s", e)

        self._running = True

        # Emit bot started event
        self._emit_event(
            ZaloEventType.BOT_STARTED,
            ZaloBotStatusPayload(
                oa_id=self._oa_info.oa_id if self._oa_info else None,
                oa_name=self._oa_info.name if self._oa_info else None,
                update_mode=self.config.update_mode,
                timestamp=int(time.time() * 1000),
            ),
        )

        logger.info("Zalo service started successfully in %s mode", self.config.update_mode)

    async def stop(self) -> None:
        """Stop the Zalo service."""
        if self._running:
            logger.info("Stopping Zalo service...")

            # Emit bot stopped event
            self._emit_event(
                ZaloEventType.BOT_STOPPED,
                ZaloBotStatusPayload(
                    oa_id=self._oa_info.oa_id if self._oa_info else None,
                    oa_name=self._oa_info.name if self._oa_info else None,
                    update_mode=self.config.update_mode,
                    timestamp=int(time.time() * 1000),
                ),
            )

            if self._client:
                await self._client.close()
                self._client = None

            self._running = False
            logger.info("Zalo service stopped")

    async def probe_zalo(self, timeout_s: float = 5.0) -> ZaloBotProbe:
        """Probe the Zalo OA connection for health checks.
        
        Args:
            timeout_s: Timeout in seconds.
            
        Returns:
            Probe result.
        """
        if self._client is None:
            return ZaloBotProbe(
                ok=False,
                error="Client not initialized",
                latency_ms=0,
            )

        start_time = time.time()
        try:
            oa_info = await self._client.get_oa_info()
            latency_ms = int((time.time() - start_time) * 1000)

            return ZaloBotProbe(
                ok=True,
                oa=oa_info,
                latency_ms=latency_ms,
            )
        except Exception as e:
            latency_ms = int((time.time() - start_time) * 1000)
            return ZaloBotProbe(
                ok=False,
                error=str(e),
                latency_ms=latency_ms,
            )

    async def send_message(self, user_id: str, text: str) -> str | None:
        """Send a text message.
        
        Args:
            user_id: Recipient user ID.
            text: Message text.
            
        Returns:
            Message ID or None on failure.
        """
        if self._client is None:
            raise ClientNotInitializedError()

        params = ZaloSendMessageParams(
            user_id=user_id,
            text=text[:MAX_MESSAGE_LENGTH],
        )

        try:
            message_id = await self._client.send_message(params)

            self._emit_event(
                ZaloEventType.MESSAGE_SENT,
                {
                    "user_id": user_id,
                    "message_id": message_id,
                    "text": text,
                    "success": True,
                },
            )

            return message_id
        except Exception as e:
            logger.exception("Failed to send message to %s", user_id)
            return None

    async def send_image(
        self,
        user_id: str,
        image_url: str,
        caption: str | None = None,
    ) -> str | None:
        """Send an image message.
        
        Args:
            user_id: Recipient user ID.
            image_url: Image URL.
            caption: Optional caption.
            
        Returns:
            Message ID or None on failure.
        """
        if self._client is None:
            raise ClientNotInitializedError()

        params = ZaloSendImageParams(
            user_id=user_id,
            image_url=image_url,
            caption=caption,
        )

        try:
            return await self._client.send_image(params)
        except Exception:
            logger.exception("Failed to send image to %s", user_id)
            return None

    async def refresh_token(self) -> None:
        """Refresh the access token."""
        if not self.config.refresh_token:
            raise ValueError("No refresh token configured")

        result = await ZaloClient.refresh_token(
            self.config.app_id,
            self.config.secret_key,
            self.config.refresh_token,
        )

        # Update config
        self.config.access_token = result["access_token"]
        self.config.refresh_token = result["refresh_token"]

        # Update client
        if self._client:
            self._client.set_access_token(result["access_token"])

        self._emit_event(
            ZaloEventType.TOKEN_REFRESHED,
            {
                "expires_in": result["expires_in"],
                "timestamp": int(time.time() * 1000),
            },
        )

        logger.info("Access token refreshed successfully")

    def on_event(self, event_type: ZaloEventType, handler: Callable[..., None]) -> None:
        """Register an event handler.
        
        Args:
            event_type: Event type to handle.
            handler: Handler function.
        """
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    def _emit_event(self, event_type: ZaloEventType, payload: Any) -> None:
        """Emit an event to registered handlers.
        
        Args:
            event_type: Event type.
            payload: Event payload.
        """
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in event handler for %s", event_type)
