"""Hermetic tests for Polymarket plugin actions.

These tests must not require network access or secrets. They validate the
action-layer parsing/filtering and error handling using an injected client.
"""

from typing import cast

import pytest

from elizaos_plugin_polymarket.actions import markets
from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.types import MarketFilters


class FakeClobClient:
    def __init__(self) -> None:
        def market(
            *,
            condition_id: str,
            question_id: str,
            category: str,
            active: bool,
            closed: bool,
            question: str,
        ) -> dict[str, object]:
            return {
                "condition_id": condition_id,
                "question_id": question_id,
                "tokens": (
                    {"token_id": f"{condition_id}-YES", "outcome": "YES"},
                    {"token_id": f"{condition_id}-NO", "outcome": "NO"},
                ),
                "rewards": {
                    "min_size": 1.0,
                    "max_spread": 0.01,
                    "event_start_date": "2026-01-01T00:00:00Z",
                    "event_end_date": "2026-12-31T00:00:00Z",
                    "in_game_multiplier": 1.0,
                    "reward_epoch": 1,
                },
                "minimum_order_size": "1",
                "minimum_tick_size": "0.01",
                "category": category,
                "end_date_iso": "2026-12-31T00:00:00Z",
                "game_start_time": "2026-01-01T00:00:00Z",
                "question": question,
                "market_slug": f"slug-{condition_id}",
                "min_incentive_size": "0",
                "max_incentive_spread": "0",
                "active": active,
                "closed": closed,
                "seconds_delay": 0,
                "icon": "https://example.com/icon.png",
                "fpmm": "0x0000000000000000000000000000000000000000",
            }

        self._markets = [
            market(
                condition_id="c1",
                question_id="q1",
                question="Will BTC be above 100k?",
                category="crypto",
                active=True,
                closed=False,
            ),
            market(
                condition_id="c2",
                question_id="q2",
                question="Will it rain tomorrow?",
                category="weather",
                active=True,
                closed=True,
            ),
            market(
                condition_id="c3",
                question_id="q3",
                question="Will Team A win?",
                category="sports",
                active=False,
                closed=False,
            ),
        ]

    def get_markets(self, *, next_cursor: str | None = None) -> dict[str, object]:
        _ = next_cursor
        return {"limit": 100, "next_cursor": "", "data": list(self._markets)}

    def get_simplified_markets(self, *, next_cursor: str | None = None) -> dict[str, object]:
        _ = next_cursor
        return {"limit": 100, "next_cursor": "", "data": list(self._markets)}

    def get_sampling_markets(self, *, next_cursor: str | None = None) -> dict[str, object]:
        _ = next_cursor
        return {"limit": 100, "next_cursor": "", "data": list(self._markets)}

    def get_market(self, condition_id: str) -> object:
        for market in self._markets:
            if market["condition_id"] == condition_id:
                return market
        return {}


class NoMethodsClient:
    pass


@pytest.mark.asyncio
async def test_get_markets_filters_category_and_active_and_limit() -> None:
    client = FakeClobClient()
    filters = MarketFilters(category="CRYPTO", active=True, limit=1)
    response = await markets.get_markets(filters=filters, client=client)
    assert response.count == 1
    assert len(response.data) == 1
    assert response.data[0].category.lower() == "crypto"
    assert response.data[0].active is True


@pytest.mark.asyncio
async def test_get_open_markets_only_active_and_not_closed() -> None:
    client = FakeClobClient()
    response = await markets.get_open_markets(limit=10, client=client)
    assert response.count == 1
    assert len(response.data) == 1
    assert response.data[0].active is True
    assert response.data[0].closed is False


@pytest.mark.asyncio
async def test_get_market_details_requires_condition_id() -> None:
    client = FakeClobClient()
    with pytest.raises(PolymarketError) as excinfo:
        await markets.get_market_details("", client=client)
    assert excinfo.value.code == PolymarketErrorCode.INVALID_MARKET


@pytest.mark.asyncio
async def test_get_market_details_missing_market_raises() -> None:
    client = FakeClobClient()
    with pytest.raises(PolymarketError) as excinfo:
        await markets.get_market_details("does-not-exist", client=client)
    assert excinfo.value.code == PolymarketErrorCode.INVALID_MARKET


@pytest.mark.asyncio
async def test_missing_client_method_surfaces_polymarket_error() -> None:
    client = NoMethodsClient()
    with pytest.raises(PolymarketError) as excinfo:
        await markets.get_markets(client=cast(markets.ClobMarketClientProtocol, client))
    assert excinfo.value.code == PolymarketErrorCode.API_ERROR
