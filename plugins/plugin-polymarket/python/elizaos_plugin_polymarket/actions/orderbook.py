"""
Order book actions for Polymarket.
"""

from collections.abc import Callable
from typing import Protocol, cast

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_clob_client
from elizaos_plugin_polymarket.types import (
    BookEntry,
    OrderBook,
    OrderSide,
)


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
        fn = getattr(client, "get_order_book", None)
        if not callable(fn):
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "get_order_book method not available in CLOB client",
            )

        response_obj = cast(Callable[[str], object], fn)(token_id)
        response: dict[str, object] = response_obj if isinstance(response_obj, dict) else {}

        bids: list[BookEntry] = []
        bids_obj = response.get("bids", [])
        if isinstance(bids_obj, list):
            for b in bids_obj:
                if not isinstance(b, dict):
                    continue
                price = b.get("price")
                size = b.get("size")
                if isinstance(price, str) and isinstance(size, str):
                    bids.append(BookEntry(price=price, size=size))

        asks: list[BookEntry] = []
        asks_obj = response.get("asks", [])
        if isinstance(asks_obj, list):
            for a in asks_obj:
                if not isinstance(a, dict):
                    continue
                price = a.get("price")
                size = a.get("size")
                if isinstance(price, str) and isinstance(size, str):
                    asks.append(BookEntry(price=price, size=size))

        return OrderBook(
            market=str(response.get("market", "")),
            asset_id=str(response.get("asset_id", token_id)),
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
        fn = getattr(client, "get_order_books_depth", None)
        if not callable(fn):
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "get_order_books_depth method not available in CLOB client",
            )

        response_obj = cast(Callable[[list[str]], object], fn)(token_ids)
        if not isinstance(response_obj, dict):
            return {}

        out: dict[str, dict[str, int]] = {}
        for token_id, depth_obj in response_obj.items():
            if not isinstance(token_id, str):
                continue
            if not isinstance(depth_obj, dict):
                continue
            inner: dict[str, int] = {}
            for k, v in depth_obj.items():
                if isinstance(k, str) and isinstance(v, int):
                    inner[k] = v
            out[token_id] = inner

        return out
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
        fn = getattr(client, "get_midpoint", None)
        if not callable(fn):
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "get_midpoint method not available in CLOB client",
            )
        midpoint = cast(Callable[[str], object], fn)(token_id)
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
        fn = getattr(client, "get_spread", None)
        if not callable(fn):
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "get_spread method not available in CLOB client",
            )
        spread = cast(Callable[[str], object], fn)(token_id)
        return str(spread)
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to get spread: {e}",
            cause=e,
        ) from e


async def get_order_book_summary(
    token_id: str,
    runtime: RuntimeProtocol | None = None,
) -> dict[str, object]:
    """
    Get order book summary for a specific token, including best bid/ask and spread.

    Args:
        token_id: The token ID to get order book summary for
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary with order book summary data

    Raises:
        PolymarketError: If fetching order book summary fails
    """
    if not token_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_TOKEN,
            "Token ID is required",
        )

    try:
        order_book = await get_order_book(token_id, runtime)

        best_bid = order_book.bids[0] if order_book.bids else None
        best_ask = order_book.asks[0] if order_book.asks else None

        spread = None
        midpoint = None

        if best_bid and best_ask:
            bid_price = float(best_bid.price)
            ask_price = float(best_ask.price)
            spread = ask_price - bid_price
            midpoint = (bid_price + ask_price) / 2

        return {
            "token_id": token_id,
            "best_bid": {
                "price": best_bid.price if best_bid else None,
                "size": best_bid.size if best_bid else None,
            },
            "best_ask": {
                "price": best_ask.price if best_ask else None,
                "size": best_ask.size if best_ask else None,
            },
            "spread": str(spread) if spread is not None else None,
            "midpoint": str(midpoint) if midpoint is not None else None,
            "bid_levels": len(order_book.bids),
            "ask_levels": len(order_book.asks),
        }

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to get order book summary: {e}",
            cause=e,
        ) from e
