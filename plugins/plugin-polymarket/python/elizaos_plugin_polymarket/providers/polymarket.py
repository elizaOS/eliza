from __future__ import annotations

import os
from datetime import UTC, datetime

from elizaos_plugin_polymarket.constants import DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID
from elizaos_plugin_polymarket.providers.clob import RuntimeProtocol


def _get_setting(runtime: RuntimeProtocol | None, key: str) -> str | None:
    if runtime is not None:
        value = runtime.get_setting(key)
        if value:
            return value
    return os.environ.get(key)


async def get_polymarket_context(
    runtime: RuntimeProtocol | None = None,
    _message: object | None = None,
    _state: object | None = None,
) -> dict[str, object]:
    clob_api_url = _get_setting(runtime, "CLOB_API_URL") or DEFAULT_CLOB_API_URL

    has_private_key = bool(
        _get_setting(runtime, "POLYMARKET_PRIVATE_KEY")
        or _get_setting(runtime, "EVM_PRIVATE_KEY")
        or _get_setting(runtime, "WALLET_PRIVATE_KEY")
        or _get_setting(runtime, "PRIVATE_KEY")
    )

    has_api_creds = bool(
        _get_setting(runtime, "CLOB_API_KEY")
        and (_get_setting(runtime, "CLOB_API_SECRET") or _get_setting(runtime, "CLOB_SECRET"))
    )

    features_available: list[str] = ["market_data", "price_feeds", "order_book"]
    if has_private_key:
        features_available.append("wallet_operations")
    if has_api_creds:
        features_available.extend(["authenticated_trading", "order_management"])

    return {
        "text": (
            f"Connected to Polymarket CLOB at {clob_api_url} on Polygon (Chain ID: {POLYGON_CHAIN_ID}). "
            f"Features available: {', '.join(features_available)}."
        ),
        "values": {
            "clobApiUrl": clob_api_url,
            "chainId": POLYGON_CHAIN_ID,
            "serviceStatus": "active",
            "hasPrivateKey": has_private_key,
            "hasApiCreds": has_api_creds,
            "featuresAvailable": features_available,
        },
        "data": {
            "timestamp": datetime.now(UTC).isoformat(),
            "service": "polymarket",
        },
    }


polymarket_provider = {
    "name": "POLYMARKET_PROVIDER",
    "description": "Provides current Polymarket market information and context",
    "get": get_polymarket_context,
}
