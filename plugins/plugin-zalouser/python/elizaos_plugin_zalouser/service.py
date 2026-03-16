"""Zalo User service implementation."""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from typing import Any

from elizaos_plugin_zalouser.client import (
    check_zca_authenticated,
    check_zca_installed,
    get_zca_user_info,
    list_friends as client_list_friends,
    list_groups as client_list_groups,
    run_zca,
    send_image,
    send_link,
    send_message as client_send_message,
    ZcaRunOptions,
)
from elizaos_plugin_zalouser.config import DEFAULT_PROFILE, MAX_MESSAGE_LENGTH, ZaloUserConfig
from elizaos_plugin_zalouser.error import (
    AlreadyRunningError,
    NotAuthenticatedError,
    ZcaNotInstalledError,
)
from elizaos_plugin_zalouser.types import (
    SendMediaParams,
    SendMessageParams,
    SendMessageResult,
    ZaloChat,
    ZaloFriend,
    ZaloGroup,
    ZaloUser,
    ZaloUserChatType,
    ZaloUserClientStatus,
    ZaloUserEventType,
    ZaloUserInfo,
    ZaloUserProbe,
    ZaloUserQrCodePayload,
)

logger = logging.getLogger(__name__)


class ZaloUserService:
    """Zalo User service for elizaOS."""

    def __init__(self, config: ZaloUserConfig) -> None:
        self.config = config
        self._running = False
        self._current_user: ZaloUserInfo | None = None
        self._known_chats: dict[str, ZaloChat] = {}
        self._event_handlers: dict[ZaloUserEventType, list[Callable[..., None]]] = {}

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._running

    @property
    def current_user(self) -> ZaloUserInfo | None:
        """Get the current authenticated user."""
        return self._current_user

    def on_event(
        self, event_type: ZaloUserEventType, handler: Callable[..., None]
    ) -> None:
        """Register an event handler."""
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    def _emit_event(self, event_type: ZaloUserEventType, payload: Any) -> None:
        """Emit an event to registered handlers."""
        handlers = self._event_handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(payload)
            except Exception:
                logger.exception("Error in event handler for %s", event_type)

    async def probe(self, timeout_ms: int = 5000) -> ZaloUserProbe:
        """Probe the Zalo connection for health checks."""
        start_time = time.time()

        # Check zca installed
        if not await check_zca_installed():
            return ZaloUserProbe(
                ok=False,
                error="zca-cli not found in PATH",
                latency_ms=int((time.time() - start_time) * 1000),
            )

        # Check authenticated
        profile = self.config.default_profile
        if not await check_zca_authenticated(profile):
            return ZaloUserProbe(
                ok=False,
                error="Not authenticated",
                latency_ms=int((time.time() - start_time) * 1000),
            )

        # Get user info
        user_info = await get_zca_user_info(profile)
        if not user_info:
            return ZaloUserProbe(
                ok=False,
                error="Failed to get user info",
                latency_ms=int((time.time() - start_time) * 1000),
            )

        return ZaloUserProbe(
            ok=True,
            user=ZaloUser(
                id=user_info.user_id,
                displayName=user_info.display_name,
                avatar=user_info.avatar,
            ),
            latency_ms=int((time.time() - start_time) * 1000),
        )

    async def start(self) -> None:
        """Start the service."""
        if self._running:
            raise AlreadyRunningError()

        self.config.validate_config()

        logger.info("Starting Zalo User service...")

        # Check zca installed
        if not await check_zca_installed():
            raise ZcaNotInstalledError()

        profile = self.config.default_profile

        # Check authenticated
        if not await check_zca_authenticated(profile):
            raise NotAuthenticatedError(profile)

        # Get user info
        self._current_user = await get_zca_user_info(profile)
        if self._current_user:
            logger.info(
                "Zalo User connected: %s (%s)",
                self._current_user.display_name,
                self._current_user.user_id,
            )

        self._running = True

        # Emit started event
        self._emit_event(
            ZaloUserEventType.CLIENT_STARTED,
            ZaloUserClientStatus(
                profile=profile,
                user=ZaloUser(
                    id=self._current_user.user_id,
                    displayName=self._current_user.display_name,
                    avatar=self._current_user.avatar,
                )
                if self._current_user
                else None,
                running=True,
                timestamp=int(time.time() * 1000),
            ),
        )

        logger.info("Zalo User service started successfully")

    async def stop(self) -> None:
        """Stop the service."""
        logger.info("Stopping Zalo User service...")

        self._running = False

        # Emit stopped event
        self._emit_event(
            ZaloUserEventType.CLIENT_STOPPED,
            ZaloUserClientStatus(
                profile=self.config.default_profile,
                user=ZaloUser(
                    id=self._current_user.user_id,
                    displayName=self._current_user.display_name,
                    avatar=self._current_user.avatar,
                )
                if self._current_user
                else None,
                running=False,
                timestamp=int(time.time() * 1000),
            ),
        )

        logger.info("Zalo User service stopped")

    async def send_message(self, params: SendMessageParams) -> SendMessageResult:
        """Send a text message."""
        profile = params.profile or self.config.default_profile

        ok, message_id, error = await client_send_message(
            params.thread_id,
            params.text,
            profile,
            params.is_group,
        )

        if ok:
            self._emit_event(
                ZaloUserEventType.MESSAGE_SENT,
                {"threadId": params.thread_id, "messageId": message_id},
            )

        return SendMessageResult(
            success=ok,
            threadId=params.thread_id,
            messageId=message_id,
            error=error,
        )

    async def send_media(self, params: SendMediaParams) -> SendMessageResult:
        """Send a media message."""
        profile = params.profile or self.config.default_profile

        # Determine media type from URL
        lower_url = params.media_url.lower()

        if any(lower_url.endswith(ext) for ext in (".mp4", ".mov", ".avi", ".webm")):
            # Video - use image command
            ok, message_id, error = await send_image(
                params.thread_id,
                params.media_url,
                params.caption,
                profile,
                params.is_group,
            )
        elif any(
            lower_url.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp")
        ):
            ok, message_id, error = await send_image(
                params.thread_id,
                params.media_url,
                params.caption,
                profile,
                params.is_group,
            )
        elif lower_url.startswith(("http://", "https://")):
            ok, message_id, error = await send_link(
                params.thread_id,
                params.media_url,
                profile,
                params.is_group,
            )
        else:
            ok, message_id, error = await send_image(
                params.thread_id,
                params.media_url,
                params.caption,
                profile,
                params.is_group,
            )

        if ok:
            self._emit_event(
                ZaloUserEventType.MESSAGE_SENT,
                {"threadId": params.thread_id, "messageId": message_id},
            )

        return SendMessageResult(
            success=ok,
            threadId=params.thread_id,
            messageId=message_id,
            error=error,
        )

    async def list_friends(self, query: str | None = None) -> list[ZaloFriend]:
        """List friends."""
        return await client_list_friends(self.config.default_profile, query)

    async def list_groups(self) -> list[ZaloGroup]:
        """List groups."""
        return await client_list_groups(self.config.default_profile)

    async def start_qr_login(
        self, profile: str | None = None
    ) -> ZaloUserQrCodePayload:
        """Start QR code login."""
        target_profile = profile or self.config.default_profile

        result = await run_zca(
            ["auth", "login", "--qr-base64"],
            ZcaRunOptions(profile=target_profile, timeout_ms=30000),
        )

        if not result.ok:
            return ZaloUserQrCodePayload(
                message=result.stderr or "Failed to start QR login",
                profile=target_profile,
            )

        # Extract QR code data URL
        qr_match = re.search(r"data:image/png;base64,[A-Za-z0-9+/=]+", result.stdout)
        if qr_match:
            payload = ZaloUserQrCodePayload(
                qrDataUrl=qr_match.group(),
                message="Scan QR code with Zalo app",
                profile=target_profile,
            )
            self._emit_event(ZaloUserEventType.QR_CODE_READY, payload)
            return payload

        return ZaloUserQrCodePayload(
            message=result.stdout or "QR login started",
            profile=target_profile,
        )

    async def wait_for_login(
        self, profile: str | None = None, timeout_ms: int = 60000
    ) -> tuple[bool, str]:
        """Wait for login to complete."""
        target_profile = profile or self.config.default_profile

        result = await run_zca(
            ["auth", "status"],
            ZcaRunOptions(profile=target_profile, timeout_ms=timeout_ms),
        )

        if result.ok:
            self._emit_event(
                ZaloUserEventType.LOGIN_SUCCESS,
                {"profile": target_profile, "timestamp": int(time.time() * 1000)},
            )
            return (True, "Login successful")

        self._emit_event(
            ZaloUserEventType.LOGIN_FAILED,
            {
                "profile": target_profile,
                "error": result.stderr,
                "timestamp": int(time.time() * 1000),
            },
        )
        return (False, result.stderr or "Login pending")

    async def logout(self, profile: str | None = None) -> tuple[bool, str]:
        """Logout from Zalo."""
        target_profile = profile or self.config.default_profile

        result = await run_zca(
            ["auth", "logout"],
            ZcaRunOptions(profile=target_profile, timeout_ms=10000),
        )

        return (
            result.ok,
            "Logged out" if result.ok else (result.stderr or "Failed to logout"),
        )

    @staticmethod
    def split_message(text: str, limit: int = MAX_MESSAGE_LENGTH) -> list[str]:
        """Split a message into chunks."""
        if not text or len(text) <= limit:
            return [text] if text else []

        chunks: list[str] = []
        remaining = text

        while len(remaining) > limit:
            window = remaining[:limit]
            last_newline = window.rfind("\n")
            last_space = window.rfind(" ")
            break_idx = last_newline if last_newline > 0 else (last_space if last_space > 0 else limit)

            chunk = remaining[:break_idx].rstrip()
            if chunk:
                chunks.append(chunk)

            next_start = min(len(remaining), break_idx + 1)
            remaining = remaining[next_start:].lstrip()

        if remaining:
            chunks.append(remaining)

        return chunks
