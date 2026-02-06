"""
HTTP client for ElizaCloud API.

Typed request methods with automatic auth headers,
structured error handling, and WS URL construction.
"""

from __future__ import annotations

import json
import logging
from typing import TypeVar

import httpx

from elizaos_plugin_elizacloud.types.cloud import (
    CloudApiError,
    CloudApiErrorBody,
    InsufficientCreditsError,
)

logger = logging.getLogger("elizacloud.api")

T = TypeVar("T")


class CloudApiClient:
    """HTTP client for the ElizaCloud REST API."""

    def __init__(self, base_url: str, api_key: str | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    def set_api_key(self, key: str) -> None:
        self._api_key = key

    def set_base_url(self, url: str) -> None:
        self._base_url = url.rstrip("/")

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def api_key(self) -> str | None:
        return self._api_key

    def build_ws_url(self, path: str) -> str:
        """Build a WebSocket URL from the base URL, replacing http(s) with ws(s)."""
        url = self._base_url
        if url.startswith("https"):
            url = "wss" + url[5:]
        elif url.startswith("http"):
            url = "ws" + url[4:]
        return f"{url}{path}"

    async def get(self, path: str) -> dict[str, object]:
        """Send an authenticated GET request."""
        return await self._request("GET", path)

    async def post(self, path: str, body: dict[str, object]) -> dict[str, object]:
        """Send an authenticated POST request."""
        return await self._request("POST", path, body)

    async def delete(self, path: str) -> dict[str, object]:
        """Send an authenticated DELETE request."""
        return await self._request("DELETE", path)

    async def post_unauthenticated(
        self, path: str, body: dict[str, object]
    ) -> dict[str, object]:
        """POST without auth header — used for device-auth."""
        return await self._request("POST", path, body, skip_auth=True)

    async def _request(
        self,
        method: str,
        path: str,
        body: dict[str, object] | None = None,
        *,
        skip_auth: bool = False,
    ) -> dict[str, object]:
        url = f"{self._base_url}{path}"
        logger.debug("[CloudAPI] %s %s", method, url)

        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if not skip_auth and self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.request(
                method,
                url,
                headers=headers,
                content=json.dumps(body) if body else None,
            )

        return self._handle_response(response)

    @staticmethod
    def _handle_response(response: httpx.Response) -> dict[str, object]:
        content_type = response.headers.get("content-type", "")

        if "application/json" not in content_type:
            if not response.is_success:
                raise CloudApiError(
                    response.status_code,
                    CloudApiErrorBody(
                        success=False,
                        error=f"HTTP {response.status_code}: {response.reason_phrase}",
                    ),
                )
            return {"success": True}

        data: dict[str, object] = response.json()

        if not response.is_success:
            err_body = CloudApiErrorBody(
                success=False,
                error=str(data.get("error", f"HTTP {response.status_code}")),
                details=data.get("details"),  # type: ignore[arg-type]
                required_credits=data.get("requiredCredits"),  # type: ignore[arg-type]
                quota=data.get("quota"),  # type: ignore[arg-type]
            )
            if response.status_code == 402:
                raise InsufficientCreditsError(err_body)
            raise CloudApiError(response.status_code, err_body)

        return data
