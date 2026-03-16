"""Tests for Polymarket plugin types."""

from elizaos_plugin_polymarket.types import (
    MarketFilters,
    MarketsResponse,
    OrderSide,
    OrderStatus,
    SimplifiedMarketsResponse,
)


class TestMarketTypes:
    """Tests for market types."""

    def test_order_side_values(self) -> None:
        """Test OrderSide enum values."""
        assert OrderSide.BUY.value == "BUY"
        assert OrderSide.SELL.value == "SELL"

    def test_order_status_values(self) -> None:
        """Test OrderStatus enum values."""
        assert "MATCHED" in [s.value for s in OrderStatus]
        assert "OPEN" in [s.value for s in OrderStatus]

    def test_market_filters_default(self) -> None:
        """Test MarketFilters default values."""
        filters = MarketFilters()
        assert filters.category is None
        assert filters.active is None
        assert filters.limit is None

    def test_market_filters_with_values(self) -> None:
        """Test MarketFilters with custom values."""
        filters = MarketFilters(category="crypto", active=True, limit=10)
        assert filters.category == "crypto"
        assert filters.active is True
        assert filters.limit == 10


class TestMarketsResponse:
    """Tests for MarketsResponse."""

    def test_empty_response(self) -> None:
        """Test empty MarketsResponse."""
        response = MarketsResponse(limit=100, count=0, next_cursor="", data=[])
        assert response.count == 0
        assert response.data == []


class TestSimplifiedMarketsResponse:
    """Tests for SimplifiedMarketsResponse."""

    def test_empty_response(self) -> None:
        """Test empty SimplifiedMarketsResponse."""
        response = SimplifiedMarketsResponse(limit=100, count=0, next_cursor="", data=[])
        assert response.count == 0
        assert response.data == []
