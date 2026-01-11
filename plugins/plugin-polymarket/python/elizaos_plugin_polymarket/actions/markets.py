"""
Market retrieval actions for Polymarket.
"""

from typing import Protocol

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_clob_client
from elizaos_plugin_polymarket.types import (
    Market,
    MarketFilters,
    MarketsResponse,
    SimplifiedMarket,
    SimplifiedMarketsResponse,
)


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


async def get_markets(
    runtime: RuntimeProtocol | None = None,
    filters: MarketFilters | None = None,
) -> MarketsResponse:
    """
    Retrieve all markets from Polymarket.

    Args:
        runtime: Optional agent runtime for settings
        filters: Optional filters for markets

    Returns:
        Paginated markets response

    Raises:
        PolymarketError: If fetching markets fails
    """
    try:
        client = get_clob_client(runtime)
        next_cursor = filters.next_cursor if filters else None

        response = client.get_markets(next_cursor=next_cursor)

        # Parse and return as typed response
        markets = []
        for market_data in response.get("data", []):
            try:
                market = Market.model_validate(market_data)
                markets.append(market)
            except Exception:
                # Skip invalid markets
                continue

        # Apply client-side filters if provided
        if filters:
            if filters.category:
                markets = [m for m in markets if m.category.lower() == filters.category.lower()]
            if filters.active is not None:
                markets = [m for m in markets if m.active == filters.active]
            if filters.limit:
                markets = markets[: filters.limit]

        return MarketsResponse(
            limit=response.get("limit", 100),
            count=len(markets),
            next_cursor=response.get("next_cursor", ""),
            data=markets,
        )
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch markets: {e}",
            cause=e,
        ) from e


async def get_simplified_markets(
    runtime: RuntimeProtocol | None = None,
    next_cursor: str | None = None,
) -> SimplifiedMarketsResponse:
    """
    Retrieve simplified markets from Polymarket.

    Args:
        runtime: Optional agent runtime for settings
        next_cursor: Optional pagination cursor

    Returns:
        Paginated simplified markets response

    Raises:
        PolymarketError: If fetching markets fails
    """
    try:
        client = get_clob_client(runtime)
        response = client.get_simplified_markets(next_cursor=next_cursor)

        markets = []
        for market_data in response.get("data", []):
            try:
                market = SimplifiedMarket.model_validate(market_data)
                markets.append(market)
            except Exception:
                continue

        return SimplifiedMarketsResponse(
            limit=response.get("limit", 100),
            count=len(markets),
            next_cursor=response.get("next_cursor", ""),
            data=markets,
        )
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch simplified markets: {e}",
            cause=e,
        ) from e


async def get_market_details(
    condition_id: str,
    runtime: RuntimeProtocol | None = None,
) -> Market:
    """
    Get detailed information about a specific market.

    Args:
        condition_id: The market condition ID
        runtime: Optional agent runtime for settings

    Returns:
        Market details

    Raises:
        PolymarketError: If fetching market fails
    """
    if not condition_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_MARKET,
            "Condition ID is required",
        )

    try:
        client = get_clob_client(runtime)
        response = client.get_market(condition_id)

        if not response:
            raise PolymarketError(
                PolymarketErrorCode.INVALID_MARKET,
                f"Market not found for condition ID: {condition_id}",
            )

        return Market.model_validate(response)
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch market details: {e}",
            cause=e,
        ) from e


async def get_sampling_markets(
    runtime: RuntimeProtocol | None = None,
    next_cursor: str | None = None,
) -> SimplifiedMarketsResponse:
    """
    Get markets with rewards enabled (sampling markets).

    Args:
        runtime: Optional agent runtime for settings
        next_cursor: Optional pagination cursor

    Returns:
        Paginated sampling markets response

    Raises:
        PolymarketError: If fetching markets fails
    """
    try:
        client = get_clob_client(runtime)
        response = client.get_sampling_markets(next_cursor=next_cursor)

        markets = []
        for market_data in response.get("data", []):
            try:
                market = SimplifiedMarket.model_validate(market_data)
                markets.append(market)
            except Exception:
                continue

        return SimplifiedMarketsResponse(
            limit=response.get("limit", 100),
            count=len(markets),
            next_cursor=response.get("next_cursor", ""),
            data=markets,
        )
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch sampling markets: {e}",
            cause=e,
        ) from e





