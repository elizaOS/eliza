from typing import Protocol

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_authenticated_clob_client, get_clob_client


class RuntimeProtocol(Protocol):
    def get_setting(self, key: str) -> str | None:
        ...


async def check_order_scoring(
    order_ids: list[str],
    runtime: RuntimeProtocol | None = None,
) -> dict[str, bool]:
    if not order_ids:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "At least one order ID is required",
        )

    try:
        client = get_authenticated_clob_client(runtime)

        # Check if client has areOrdersScoring method
        if hasattr(client, "areOrdersScoring"):
            response = client.areOrdersScoring({"orderIds": order_ids})
            if isinstance(response, dict):
                return response
            else:
                # Convert list response to dict if needed
                return {order_id: bool(response) for order_id in order_ids}
        else:
            # Fallback: return False for all orders if method not available
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "areOrdersScoring method not available in CLOB client. "
                "Please use the Polymarket API directly or update py-clob-client.",
            )

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to check order scoring: {e}",
            cause=e,
        ) from e


async def get_active_orders(
    market_id: str | None = None,
    asset_id: str | None = None,
    runtime: RuntimeProtocol | None = None,
) -> list[dict]:
    """
    Get active orders for the authenticated user.

    Args:
        market_id: Optional market condition ID filter
        asset_id: Optional asset ID filter
        runtime: Optional agent runtime for settings

    Returns:
        List of active orders

    Raises:
        PolymarketError: If fetching orders fails
    """
    try:
        client = get_authenticated_clob_client(runtime)

        # Build parameters
        params: dict[str, str] = {}
        if market_id:
            params["market"] = market_id
        if asset_id:
            params["asset_id"] = asset_id

        # Use getOpenOrders if available, otherwise fallback to get_orders
        if hasattr(client, "getOpenOrders"):
            orders = client.getOpenOrders(params if params else None)
        elif hasattr(client, "get_orders"):
            orders = client.get_orders(**params) if params else client.get_orders()
        else:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "getOpenOrders or get_orders method not available in CLOB client",
            )

        if isinstance(orders, dict):
            return orders.get("data", [])
        elif isinstance(orders, list):
            return orders
        else:
            return []

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch active orders: {e}",
            cause=e,
        ) from e


async def get_trade_history(
    market_id: str | None = None,
    asset_id: str | None = None,
    limit: int = 20,
    runtime: RuntimeProtocol | None = None,
) -> dict[str, object]:
    """
    Get trade history for the authenticated user.

    Args:
        market_id: Optional market condition ID filter
        asset_id: Optional asset ID filter
        limit: Maximum number of trades to return
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary with trades list and pagination info

    Raises:
        PolymarketError: If fetching trade history fails
    """
    try:
        client = get_authenticated_clob_client(runtime)

        # Build parameters
        params: dict[str, object] = {}
        if market_id:
            params["market"] = market_id
        if asset_id:
            params["asset_id"] = asset_id

        # Use getTradesPaginated if available, otherwise getTrades
        if hasattr(client, "getTradesPaginated"):
            response = client.getTradesPaginated(params if params else None)
            if isinstance(response, dict):
                trades = response.get("trades", [])
                next_cursor = response.get("next_cursor", "")
            else:
                trades = []
                next_cursor = ""
        elif hasattr(client, "getTrades"):
            trades = client.getTrades(params if params else None)
            if isinstance(trades, dict):
                trades = trades.get("data", [])
            next_cursor = ""
        else:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "getTradesPaginated or getTrades method not available in CLOB client",
            )

        # Limit results
        if isinstance(trades, list) and limit:
            trades = trades[:limit]

        return {
            "trades": trades if isinstance(trades, list) else [],
            "next_cursor": next_cursor,
            "count": len(trades) if isinstance(trades, list) else 0,
        }

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch trade history: {e}",
            cause=e,
        ) from e


async def get_price_history(
    token_id: str,
    start_ts: int | None = None,
    end_ts: int | None = None,
    fidelity: int = 60,
    runtime: RuntimeProtocol | None = None,
) -> list[dict[str, object]]:
    """
    Get price history for a specific token.

    Args:
        token_id: The token ID to get price history for
        start_ts: Optional start timestamp (defaults to 24 hours ago)
        end_ts: Optional end timestamp (defaults to now)
        fidelity: Time interval in minutes (default 60)
        runtime: Optional agent runtime for settings

    Returns:
        List of price history entries with timestamp and price

    Raises:
        PolymarketError: If fetching price history fails
    """
    if not token_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_TOKEN,
            "Token ID is required",
        )

    try:
        import time

        client = get_clob_client(runtime)

        # Set default timestamps if not provided
        now = int(time.time())
        if start_ts is None:
            start_ts = now - 86400  # 24 hours ago
        if end_ts is None:
            end_ts = now

        # Use getPricesHistory if available
        if hasattr(client, "getPricesHistory"):
            response = client.getPricesHistory(
                {
                    "market": token_id,
                    "startTs": start_ts,
                    "endTs": end_ts,
                    "fidelity": fidelity,
                }
            )

            # Convert response to list of dicts
            if isinstance(response, list):
                return [
                    {"timestamp": entry.get("t", entry.get("timestamp", 0)), "price": entry.get("p", entry.get("price", "0"))}
                    for entry in response
                ]
            elif isinstance(response, dict):
                data = response.get("data", [])
                return [
                    {"timestamp": entry.get("t", entry.get("timestamp", 0)), "price": entry.get("p", entry.get("price", "0"))}
                    for entry in data
                ]
            else:
                return []
        else:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "getPricesHistory method not available in CLOB client",
            )

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch price history: {e}",
            cause=e,
        ) from e
