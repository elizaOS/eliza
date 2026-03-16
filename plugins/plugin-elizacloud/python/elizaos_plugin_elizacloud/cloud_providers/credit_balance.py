"""
creditBalanceProvider — Credit balance in agent state (60s cache).
"""

from __future__ import annotations

import logging
import time
from typing import TypedDict

from elizaos_plugin_elizacloud.services.cloud_auth_service import CloudAuthService

logger = logging.getLogger("elizacloud.providers.credits")


class ProviderResult(TypedDict, total=False):
    text: str
    values: dict[str, object]


_cache: dict[str, float] | None = None
_cache_at: float = 0.0
_TTL = 60.0


def _format_balance(balance: float) -> ProviderResult:
    low = balance < 2.0
    critical = balance < 0.5
    text = f"ElizaCloud credits: ${balance:.2f}"
    if critical:
        text += " (CRITICAL)"
    elif low:
        text += " (LOW)"
    return ProviderResult(
        text=text,
        values={
            "cloudCredits": balance,
            "cloudCreditsLow": low,
            "cloudCreditsCritical": critical,
        },
    )


async def get_credit_balance(
    auth: CloudAuthService | None = None,
) -> ProviderResult:
    """Get ElizaCloud credit balance with 60s caching."""
    global _cache, _cache_at

    if not auth or not auth.is_authenticated():
        return ProviderResult(text="")

    now = time.time()
    if _cache is not None and (now - _cache_at) < _TTL:
        return _format_balance(_cache["balance"])

    resp = await auth.get_client().get("/credits/balance")
    raw_data = resp.get("data", {})
    if not isinstance(raw_data, dict):
        raw_data = {}
    balance = float(raw_data.get("balance", 0))

    _cache = {"balance": balance}
    _cache_at = now

    if balance < 1.0:
        logger.warning("[CloudCredits] Low balance: $%.2f", balance)

    return _format_balance(balance)


credit_balance_provider: dict[str, object] = {
    "name": "elizacloud_credits",
    "description": "ElizaCloud credit balance",
    "dynamic": True,
    "position": 91,
    "get": get_credit_balance,
}
