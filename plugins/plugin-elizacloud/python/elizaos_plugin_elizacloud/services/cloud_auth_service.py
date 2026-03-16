"""
CloudAuthService — Device-based auto-signup and session management.

On first launch, derives a hardware fingerprint and calls
POST /api/v1/device-auth. The cloud backend creates a user + org +
$5 credit + API key if new, or returns the existing session.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import socket
import time

from elizaos_plugin_elizacloud.types.cloud import (
    CloudCredentials,
    DEFAULT_CLOUD_CONFIG,
    DeviceAuthResponse,
    DevicePlatform,
)
from elizaos_plugin_elizacloud.utils.cloud_api import CloudApiClient

logger = logging.getLogger("elizacloud.auth")


def _derive_device_id() -> str:
    """SHA-256 hash of hostname + platform + arch + cpu-count + (placeholder) memory."""
    raw = ":".join([
        socket.gethostname(),
        platform.system().lower(),
        platform.machine(),
        str(os.cpu_count() or 1),
        platform.processor() or "unknown",
    ])
    return hashlib.sha256(raw.encode()).hexdigest()


def _detect_platform() -> DevicePlatform:
    mapping: dict[str, DevicePlatform] = {
        "darwin": "macos",
        "windows": "windows",
        "linux": "linux",
    }
    return mapping.get(platform.system().lower(), "linux")


class CloudAuthService:
    """ElizaCloud device authentication and session management."""

    service_type = "CLOUD_AUTH"

    def __init__(self) -> None:
        self._client = CloudApiClient(DEFAULT_CLOUD_CONFIG.base_url)
        self._credentials: CloudCredentials | None = None

    @property
    def client(self) -> CloudApiClient:
        return self._client

    async def start(self, settings: dict[str, str | None] | None = None) -> None:
        """Initialize the auth service using runtime settings."""
        settings = settings or {}

        base_url = settings.get("ELIZAOS_CLOUD_BASE_URL") or DEFAULT_CLOUD_CONFIG.base_url
        self._client.set_base_url(base_url)

        # Try existing API key first
        existing_key = settings.get("ELIZAOS_CLOUD_API_KEY")
        if existing_key:
            self._client.set_api_key(existing_key)
            valid = await self._validate_api_key(existing_key)
            if valid:
                self._credentials = CloudCredentials(
                    api_key=existing_key,
                    user_id=settings.get("ELIZAOS_CLOUD_USER_ID") or "",
                    organization_id=settings.get("ELIZAOS_CLOUD_ORG_ID") or "",
                    authenticated_at=time.time(),
                )
                logger.info("[CloudAuth] Authenticated with existing API key")
                return
            logger.warning("[CloudAuth] Existing API key invalid, attempting device auth")

        # Device-based auto-signup when explicitly enabled
        enabled = settings.get("ELIZAOS_CLOUD_ENABLED")
        if enabled in ("true", "1"):
            await self.authenticate_with_device()
        else:
            logger.info("[CloudAuth] Cloud not enabled (set ELIZAOS_CLOUD_ENABLED=true)")

    async def stop(self) -> None:
        self._credentials = None

    async def _validate_api_key(self, key: str) -> bool:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{self._client.base_url}/models",
                    headers={"Authorization": f"Bearer {key}"},
                )
                return resp.is_success
        except httpx.HTTPError:
            return False

    async def authenticate_with_device(self) -> CloudCredentials:
        """Perform device-based auto-signup."""
        device_id = _derive_device_id()
        plat = _detect_platform()
        app_version = os.environ.get("ELIZAOS_CLOUD_APP_VERSION", "2.0.0-alpha")

        logger.info("[CloudAuth] Authenticating device (platform=%s)", plat)

        resp = await self._client.post_unauthenticated("/device-auth", {
            "deviceId": device_id,
            "platform": plat,
            "appVersion": app_version,
            "deviceName": socket.gethostname(),
        })

        data = resp.get("data", {})
        if not isinstance(data, dict):
            data = {}

        auth_data = DeviceAuthResponse(
            success=bool(resp.get("success")),
            data=type("DeviceAuthData", (), {
                "api_key": str(data.get("apiKey", "")),
                "user_id": str(data.get("userId", "")),
                "organization_id": str(data.get("organizationId", "")),
                "credits": float(data.get("credits", 0)),
                "is_new": bool(data.get("isNew", False)),
            })(),  # type: ignore[arg-type]
        )

        self._credentials = CloudCredentials(
            api_key=auth_data.data.api_key,
            user_id=auth_data.data.user_id,
            organization_id=auth_data.data.organization_id,
            authenticated_at=time.time(),
        )
        self._client.set_api_key(auth_data.data.api_key)

        action = "New account created" if auth_data.data.is_new else "Authenticated"
        logger.info("[CloudAuth] %s (credits: $%.2f)", action, auth_data.data.credits)

        return self._credentials

    def is_authenticated(self) -> bool:
        return self._credentials is not None

    def get_credentials(self) -> CloudCredentials | None:
        return self._credentials

    def get_api_key(self) -> str | None:
        if self._credentials:
            return self._credentials.api_key
        return self._client.api_key

    def get_client(self) -> CloudApiClient:
        return self._client

    def get_user_id(self) -> str | None:
        return self._credentials.user_id if self._credentials else None

    def get_organization_id(self) -> str | None:
        return self._credentials.organization_id if self._credentials else None
