"""
ACP Client - HTTP client for interacting with ACP-compliant merchant APIs.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import TypeVar

import httpx

from elizaos_plugin_acp.types import (
    AcpClientConfig,
    AcpError,
    CancelCheckoutSessionRequest,
    CheckoutSession,
    CompleteCheckoutSessionRequest,
    CreateCheckoutSessionRequest,
    UpdateCheckoutSessionRequest,
)

logger = logging.getLogger(__name__)

DEFAULT_API_VERSION = "2026-01-30"
DEFAULT_TIMEOUT = 30.0

T = TypeVar("T")


class AcpApiError(Exception):
    """ACP API Error."""

    def __init__(
        self,
        error_type: str,
        code: str,
        message: str,
        param: str | None = None,
    ) -> None:
        super().__init__(message)
        self.type = error_type
        self.code = code
        self.param = param

    def to_dict(self) -> dict[str, str | None]:
        """Convert to dictionary."""
        return {
            "type": self.type,
            "code": self.code,
            "message": str(self),
            "param": self.param,
        }


class AcpClient:
    """ACP Client for interacting with merchant APIs implementing the Agentic Commerce Protocol."""

    def __init__(self, config: AcpClientConfig) -> None:
        self.base_url = config.base_url.rstrip("/")
        self.api_key = config.api_key
        self.api_version = config.api_version or DEFAULT_API_VERSION
        self.default_currency = config.default_currency or "USD"
        self.timeout = (config.timeout or 30000) / 1000.0  # Convert ms to seconds

        self._client = httpx.AsyncClient(timeout=self.timeout)

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    def _build_headers(
        self,
        idempotency_key: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, str]:
        """Build request headers for ACP API calls."""
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "API-Version": self.api_version,
            "User-Agent": "elizaOS-ACP-Plugin/2.0.0 Python",
            "Timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        if request_id:
            headers["Request-Id"] = request_id
        else:
            headers["Request-Id"] = str(uuid.uuid4())

        return headers

    async def _request(
        self,
        method: str,
        path: str,
        body: dict[str, object] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, object]:
        """Make an HTTP request to the merchant API."""
        url = f"{self.base_url}{path}"
        headers = self._build_headers(idempotency_key)

        logger.debug(f"[AcpClient] {method} {url}")

        try:
            if method == "GET":
                response = await self._client.get(url, headers=headers)
            else:
                response = await self._client.post(url, headers=headers, json=body)

            data = response.json()

            if not response.is_success:
                error = AcpError.model_validate(data)
                raise AcpApiError(error.type, error.code, error.message, error.param)

            return data  # type: ignore[no-any-return]

        except httpx.TimeoutException as exc:
            raise AcpApiError("service_unavailable", "timeout", "Request timed out") from exc
        except httpx.RequestError as exc:
            raise AcpApiError(
                "service_unavailable",
                "network_error",
                str(exc),
            ) from exc

    async def create_checkout_session(
        self,
        params: CreateCheckoutSessionRequest,
        idempotency_key: str | None = None,
    ) -> CheckoutSession:
        """Create a new checkout session."""
        # Ensure currency is set
        request_dict = params.model_dump(exclude_none=True)
        if "currency" not in request_dict:
            request_dict["currency"] = self.default_currency

        data = await self._request("POST", "/checkout_sessions", request_dict, idempotency_key)
        return CheckoutSession.model_validate(data)

    async def get_checkout_session(self, session_id: str) -> CheckoutSession:
        """Get a checkout session by ID."""
        data = await self._request("GET", f"/checkout_sessions/{session_id}")
        return CheckoutSession.model_validate(data)

    async def update_checkout_session(
        self,
        session_id: str,
        params: UpdateCheckoutSessionRequest,
        idempotency_key: str | None = None,
    ) -> CheckoutSession:
        """Update a checkout session."""
        request_dict = params.model_dump(exclude_none=True)
        data = await self._request(
            "POST",
            f"/checkout_sessions/{session_id}",
            request_dict,
            idempotency_key,
        )
        return CheckoutSession.model_validate(data)

    async def complete_checkout_session(
        self,
        session_id: str,
        params: CompleteCheckoutSessionRequest,
        idempotency_key: str | None = None,
    ) -> CheckoutSession:
        """Complete a checkout session (process payment)."""
        request_dict = params.model_dump(exclude_none=True)
        data = await self._request(
            "POST",
            f"/checkout_sessions/{session_id}/complete",
            request_dict,
            idempotency_key,
        )
        return CheckoutSession.model_validate(data)

    async def cancel_checkout_session(
        self,
        session_id: str,
        params: CancelCheckoutSessionRequest | None = None,
    ) -> CheckoutSession:
        """Cancel a checkout session."""
        request_dict = params.model_dump(exclude_none=True) if params else None
        data = await self._request(
            "POST",
            f"/checkout_sessions/{session_id}/cancel",
            request_dict,
        )
        return CheckoutSession.model_validate(data)


def create_acp_client_from_env() -> AcpClient | None:
    """Create an ACP client from environment variables."""
    base_url = os.environ.get("ACP_MERCHANT_BASE_URL")

    if not base_url:
        logger.warning("[AcpClient] ACP_MERCHANT_BASE_URL not set, client not available")
        return None

    config = AcpClientConfig(
        base_url=base_url,
        api_key=os.environ.get("ACP_MERCHANT_API_KEY"),
        api_version=os.environ.get("ACP_DEFAULT_API_VERSION", DEFAULT_API_VERSION),
        default_currency=os.environ.get("ACP_DEFAULT_CURRENCY", "USD"),
    )

    return AcpClient(config)
