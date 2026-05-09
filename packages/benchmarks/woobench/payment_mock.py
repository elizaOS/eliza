"""HTTP client for the central payments mock provider.

WooBench keeps this dependency-free so local smoke runs work in a plain Python
environment. The mock API itself lives in ``test/mocks/scripts/start-mocks.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any
from urllib import error, request


@dataclass
class MockPaymentRequest:
    id: str
    amount_usd: float
    status: str
    accepted: bool
    payment_url: str
    transaction_hash: str | None = None


class MockPaymentError(RuntimeError):
    """Raised when the mock payment provider rejects a request."""


class MockPaymentClient:
    """Small client for the local payments mock server."""

    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def create_payment_request(
        self,
        *,
        amount_usd: float,
        description: str,
        metadata: dict[str, Any] | None = None,
    ) -> MockPaymentRequest:
        payload = {
            "amountUsd": amount_usd,
            "description": description,
            "metadata": metadata or {},
        }
        body = self._request_json("POST", "/v1/payment-requests", payload)
        return self._parse_payment_request(body)

    def pay_payment_request(
        self,
        payment_request_id: str,
        *,
        transaction_hash: str | None = None,
    ) -> MockPaymentRequest:
        payload = {"transactionHash": transaction_hash} if transaction_hash else {}
        body = self._request_json(
            "POST",
            f"/v1/payment-requests/{payment_request_id}/pay",
            payload,
        )
        return self._parse_payment_request(body)

    def get_payment_request(self, payment_request_id: str) -> MockPaymentRequest:
        body = self._request_json("GET", f"/v1/payment-requests/{payment_request_id}")
        return self._parse_payment_request(body)

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read().decode("utf-8")
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise MockPaymentError(
                f"payment mock returned {exc.code} for {method} {path}: {detail}"
            ) from exc
        except error.URLError as exc:
            raise MockPaymentError(f"payment mock unavailable at {self.base_url}: {exc}") from exc

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise MockPaymentError(f"payment mock returned invalid JSON: {raw[:200]}") from exc
        if not isinstance(parsed, dict):
            raise MockPaymentError("payment mock returned a non-object response")
        return parsed

    @staticmethod
    def _parse_payment_request(body: dict[str, Any]) -> MockPaymentRequest:
        value = body.get("paymentRequest")
        if not isinstance(value, dict):
            raise MockPaymentError("payment mock response missing paymentRequest")
        return MockPaymentRequest(
            id=str(value.get("id", "")),
            amount_usd=float(value.get("amountUsd", 0)),
            status=str(value.get("status", "")),
            accepted=bool(value.get("accepted") or value.get("paid")),
            payment_url=str(value.get("paymentUrl") or value.get("checkoutUrl") or ""),
            transaction_hash=(
                str(value["transactionHash"])
                if value.get("transactionHash") not in (None, "")
                else None
            ),
        )
