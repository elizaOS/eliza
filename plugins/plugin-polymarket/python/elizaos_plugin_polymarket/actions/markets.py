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
    def get_setting(self, key: str) -> str | None:
        ...


async def get_markets(
    runtime: RuntimeProtocol | None = None,
    filters: MarketFilters | None = None,
) -> MarketsResponse:
    try:
        client = get_clob_client(runtime)
        next_cursor = filters.next_cursor if filters else None

        response = client.get_markets(next_cursor=next_cursor)

        markets = []
        for market_data in response.get("data", []):
            try:
                market = Market.model_validate(market_data)
                markets.append(market)
            except Exception:  # noqa: S112, BLE001
                continue

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
    try:
        client = get_clob_client(runtime)
        response = client.get_simplified_markets(next_cursor=next_cursor)

        markets = []
        for market_data in response.get("data", []):
            try:
                market = SimplifiedMarket.model_validate(market_data)
                markets.append(market)
            except Exception:  # noqa: S112, BLE001
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
            except Exception:  # noqa: S112, BLE001
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


async def get_open_markets(
    runtime: RuntimeProtocol | None = None,
    limit: int = 10,
    next_cursor: str | None = None,
) -> MarketsResponse:
    """
    Get currently open (active and not closed) markets.

    Args:
        runtime: Optional agent runtime for settings
        limit: Maximum number of markets to return
        next_cursor: Optional pagination cursor

    Returns:
        Paginated markets response with only open markets

    Raises:
        PolymarketError: If fetching markets fails
    """
    try:
        client = get_clob_client(runtime)
        response = client.get_markets(next_cursor=next_cursor)

        markets = []
        for market_data in response.get("data", []):
            try:
                market = Market.model_validate(market_data)
                # Filter for open markets (active = True, closed = False)
                if market.active and not market.closed:
                    markets.append(market)
            except Exception:  # noqa: S112, BLE001
                continue

        # Apply limit
        if limit and len(markets) > limit:
            markets = markets[:limit]

        return MarketsResponse(
            limit=limit,
            count=len(markets),
            next_cursor=response.get("next_cursor", ""),
            data=markets,
        )
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch open markets: {e}",
            cause=e,
        ) from e


async def get_clob_markets(
    runtime: RuntimeProtocol | None = None,
    limit: int = 10,
    next_cursor: str | None = None,
) -> MarketsResponse:
    """
    Get markets directly from the Polymarket CLOB API.

    Args:
        runtime: Optional agent runtime for settings
        limit: Maximum number of markets to return
        next_cursor: Optional pagination cursor

    Returns:
        Paginated markets response

    Raises:
        PolymarketError: If fetching markets fails
    """
    try:
        client = get_clob_client(runtime)
        response = client.get_markets(next_cursor=next_cursor)

        markets = []
        for market_data in response.get("data", []):
            try:
                market = Market.model_validate(market_data)
                markets.append(market)
            except Exception:  # noqa: S112, BLE001
                continue

        # Apply limit
        if limit and len(markets) > limit:
            markets = markets[:limit]

        return MarketsResponse(
            limit=limit,
            count=len(markets),
            next_cursor=response.get("next_cursor", ""),
            data=markets,
        )
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch CLOB markets: {e}",
            cause=e,
        ) from e


async def retrieve_all_markets(
    runtime: RuntimeProtocol | None = None,
    max_pages: int = 10,
) -> dict[str, any]:
    """
    Retrieve all available markets by paginating through the entire catalog.

    Args:
        runtime: Optional agent runtime for settings
        max_pages: Maximum number of pages to fetch (default 10)

    Returns:
        Dictionary with all markets and summary statistics

    Raises:
        PolymarketError: If fetching markets fails
    """
    try:
        import time

        client = get_clob_client(runtime)
        all_markets: list[Market] = []
        next_cursor: str | None = None
        page_count = 0

        # Paginate through all markets
        while page_count < max_pages:
            response = client.get_markets(next_cursor=next_cursor)

            markets = []
            for market_data in response.get("data", []):
                try:
                    market = Market.model_validate(market_data)
                    markets.append(market)
                except Exception:  # noqa: S112, BLE001
                    continue

            all_markets.extend(markets)
            next_cursor = response.get("next_cursor")

            page_count += 1

            # Break if no more pages
            if not next_cursor:
                break

            # Small delay to respect rate limits
            time.sleep(0.1)

        # Categorize markets
        open_markets = [m for m in all_markets if m.active and not m.closed]
        closed_markets = [m for m in all_markets if m.closed]
        inactive_markets = [m for m in all_markets if not m.active and not m.closed]

        return {
            "total_markets": len(all_markets),
            "open_markets": len(open_markets),
            "closed_markets": len(closed_markets),
            "inactive_markets": len(inactive_markets),
            "pages_fetched": page_count,
            "has_more": bool(next_cursor),
            "next_cursor": next_cursor or "",
            "markets": all_markets,
        }

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to retrieve all markets: {e}",
            cause=e,
        ) from e





