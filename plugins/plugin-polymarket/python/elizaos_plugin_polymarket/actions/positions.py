"""
Position snapshot actions for Polymarket.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Protocol

from elizaos_plugin_polymarket.actions.orderbook import get_order_book
from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_authenticated_clob_client
from elizaos_plugin_polymarket.types import Position


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


@dataclass
class PositionAccumulator:
    asset_id: str
    market: str
    size: float
    average_price: float
    realized_pnl: float


def _safe_number(value: object) -> float:
    if isinstance(value, int | float):
        return float(value) if isfinite(float(value)) else 0.0
    if isinstance(value, str):
        try:
            parsed = float(value)
            return parsed if isfinite(parsed) else 0.0
        except ValueError:
            return 0.0
    return 0.0


def _extract_trade_fields(trade: dict[str, object]) -> tuple[str, str, str, float, float]:
    asset_id = trade.get("asset_id") or trade.get("token_id") or ""
    market = trade.get("market") or trade.get("market_id") or ""
    side = trade.get("side") or ""
    price = trade.get("price")
    size = trade.get("size")
    return (
        str(asset_id),
        str(market),
        str(side).upper(),
        _safe_number(price),
        _safe_number(size),
    )


def _update_position_for_trade(
    position: PositionAccumulator,
    side: str,
    price: float,
    quantity: float,
) -> None:
    if quantity <= 0 or price <= 0:
        return

    if side == "BUY":
        if position.size >= 0:
            new_size = position.size + quantity
            position.average_price = (
                0.0
                if new_size == 0
                else (position.average_price * position.size + price * quantity) / new_size
            )
            position.size = new_size
            return

        short_size = abs(position.size)
        close_size = min(short_size, quantity)
        position.realized_pnl += (position.average_price - price) * close_size
        remaining_buy = quantity - close_size
        if remaining_buy > 0:
            position.size = remaining_buy
            position.average_price = price
        else:
            position.size += quantity
        return

    if position.size <= 0:
        new_short = abs(position.size) + quantity
        position.average_price = (
            0.0
            if new_short == 0
            else (position.average_price * abs(position.size) + price * quantity) / new_short
        )
        position.size = -new_short
        return

    close_size = min(position.size, quantity)
    position.realized_pnl += (price - position.average_price) * close_size
    remaining_sell = quantity - close_size
    if remaining_sell > 0:
        position.size = -remaining_sell
        position.average_price = price
    else:
        position.size -= quantity


async def get_positions(
    limit: int = 500,
    max_pages: int = 10,
    asset_ids: list[str] | None = None,
    include_prices: bool = True,
    price_lookup_limit: int = 10,
    runtime: RuntimeProtocol | None = None,
) -> list[Position]:
    """
    Build a positions snapshot from trade history.

    Args:
        limit: Max number of trades to scan
        max_pages: Max pages of trade history to scan
        asset_ids: Filter positions to specific asset IDs
        include_prices: Fetch order book prices for unrealized PnL
        price_lookup_limit: Max number of assets to fetch prices for
        runtime: Optional agent runtime for settings

    Returns:
        List of Position entries

    Raises:
        PolymarketError: If fetching trades fails
    """
    try:
        client = get_authenticated_clob_client(runtime)
        trades: list[dict[str, object]] = []
        next_cursor: str | None = None
        pages_fetched = 0

        while pages_fetched < max_pages and len(trades) < limit:
            get_trades_paginated = getattr(client, "getTradesPaginated", None)
            if callable(get_trades_paginated):
                response_obj = get_trades_paginated(
                    {"limit": min(100, limit - len(trades)), "cursor": next_cursor}
                )
                response = response_obj if isinstance(response_obj, dict) else {}
                page_trades = response.get("trades", [])
                next_cursor = (
                    str(response.get("next_cursor"))
                    if response.get("next_cursor") is not None
                    else None
                )
                if isinstance(page_trades, list):
                    trades.extend([t for t in page_trades if isinstance(t, dict)])
            else:
                get_trades = getattr(client, "getTrades", None)
                if not callable(get_trades):
                    raise PolymarketError(
                        PolymarketErrorCode.API_ERROR,
                        "getTradesPaginated or getTrades method not available in CLOB client",
                    )
                response_obj = get_trades(None)
                page_trades = response_obj.get("data", []) if isinstance(response_obj, dict) else []
                if isinstance(page_trades, list):
                    trades.extend([t for t in page_trades if isinstance(t, dict)])
                next_cursor = None

            pages_fetched += 1
            if not next_cursor:
                break

        positions_map: dict[str, PositionAccumulator] = {}
        filter_asset_ids = asset_ids or []
        for trade in trades:
            asset_id, market, side, price, size = _extract_trade_fields(trade)
            if not asset_id or not market:
                continue
            if filter_asset_ids and asset_id not in filter_asset_ids:
                continue
            position = positions_map.get(
                asset_id,
                PositionAccumulator(
                    asset_id=asset_id,
                    market=market,
                    size=0.0,
                    average_price=0.0,
                    realized_pnl=0.0,
                ),
            )
            _update_position_for_trade(position, side, price, size)
            positions_map[asset_id] = position

        price_map: dict[str, tuple[float | None, float | None]] = {}
        if include_prices:
            asset_list = list(positions_map.keys())[: max(price_lookup_limit, 0)]
            for asset_id in asset_list:
                order_book = await get_order_book(asset_id, runtime)
                bid = _safe_number(order_book.bids[0].price) if order_book.bids else None
                ask = _safe_number(order_book.asks[0].price) if order_book.asks else None
                price_map[asset_id] = (bid if bid > 0 else None, ask if ask > 0 else None)

        positions: list[Position] = []
        for position in positions_map.values():
            if position.size == 0:
                continue
            bid, ask = price_map.get(position.asset_id, (None, None))
            reference_price = (bid + ask) / 2 if bid is not None and ask is not None else 0.0
            if reference_price > 0:
                unrealized = (
                    (reference_price - position.average_price) * position.size
                    if position.size > 0
                    else (position.average_price - reference_price) * abs(position.size)
                )
            else:
                unrealized = 0.0
            positions.append(
                Position(
                    market=position.market,
                    asset_id=position.asset_id,
                    size=f"{position.size:.6f}",
                    average_price=f"{position.average_price:.6f}",
                    realized_pnl=f"{position.realized_pnl:.6f}",
                    unrealized_pnl=f"{unrealized:.6f}",
                )
            )

        return positions
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to build positions: {e}",
            cause=e,
        ) from e
