"""
Order book actions for Polymarket.
"""

from typing import Protocol

from elizaos_plugin_polymarket.providers import get_clob_client
from elizaos_plugin_polymarket.types import (
    OrderBook,
    BookEntry,
    OrderSide,
)
from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


async def get_order_book(
    token_id: str,
    runtime: RuntimeProtocol | None = None,
) -> OrderBook:
    """
    Get order book for a specific token.

    Args:
        token_id: The token ID to get order book for
        runtime: Optional agent runtime for settings

    Returns:
        Order book data

    Raises:
        PolymarketError: If fetching order book fails
    """
    if not token_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_TOKEN,
            "Token ID is required",
        )

    try:
        client = get_clob_client(runtime)
        response = client.get_order_book(token_id)

        bids = [
            BookEntry(price=b["price"], size=b["size"])
            for b in response.get("bids", [])
        ]
        asks = [
            BookEntry(price=a["price"], size=a["size"])
            for a in response.get("asks", [])
        ]

        return OrderBook(
            market=response.get("market", ""),
            asset_id=response.get("asset_id", token_id),
            bids=bids,
            asks=asks,
        )
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch order book: {e}",
            cause=e,
        ) from e


async def get_order_book_depth(
    token_ids: list[str],
    runtime: RuntimeProtocol | None = None,
) -> dict[str, dict[str, int]]:
    """
    Get order book depth for multiple tokens.

    Args:
        token_ids: List of token IDs
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary mapping token IDs to depth data

    Raises:
        PolymarketError: If fetching depth fails
    """
    if not token_ids:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_TOKEN,
            "At least one token ID is required",
        )

    try:
        client = get_clob_client(runtime)
        response = client.get_order_books_depth(token_ids)
        return response
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch order book depth: {e}",
            cause=e,
        ) from e


async def get_best_price(
    token_id: str,
    side: OrderSide,
    runtime: RuntimeProtocol | None = None,
) -> tuple[str, str]:
    """
    Get best price for a token on specified side.

    Args:
        token_id: The token ID
        side: BUY or SELL
        runtime: Optional agent runtime for settings

    Returns:
        Tuple of (price, size) for best price

    Raises:
        PolymarketError: If fetching price fails
    """
    if not token_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_TOKEN,
            "Token ID is required",
        )

    try:
        order_book = await get_order_book(token_id, runtime)

        if side == OrderSide.BUY:
            # Best ask for buying
            if not order_book.asks:
                return ("N/A", "N/A")
            best = order_book.asks[0]
        else:
            # Best bid for selling
            if not order_book.bids:
                return ("N/A", "N/A")
            best = order_book.bids[0]

        return (best.price, best.size)
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to get best price: {e}",
            cause=e,
        ) from e


async def get_midpoint_price(
    token_id: str,
    runtime: RuntimeProtocol | None = None,
) -> str:
    """
    Get midpoint price for a token.

    Args:
        token_id: The token ID
        runtime: Optional agent runtime for settings

    Returns:
        Midpoint price as string

    Raises:
        PolymarketError: If fetching price fails
    """
    if not token_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_TOKEN,
            "Token ID is required",
        )

    try:
        client = get_clob_client(runtime)
        midpoint = client.get_midpoint(token_id)
        return str(midpoint)
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to get midpoint price: {e}",
            cause=e,
        ) from e


async def get_spread(
    token_id: str,
    runtime: RuntimeProtocol | None = None,
) -> str:
    """
    Get bid-ask spread for a token.

    Args:
        token_id: The token ID
        runtime: Optional agent runtime for settings

    Returns:
        Spread value as string

    Raises:
        PolymarketError: If fetching spread fails
    """
    if not token_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_TOKEN,
            "Token ID is required",
        )

    try:
        client = get_clob_client(runtime)
        spread = client.get_spread(token_id)
        return str(spread)
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to get spread: {e}",
            cause=e,
        ) from e


