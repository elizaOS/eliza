"""Tests for Polymarket plugin actions.

Note: All tests that require API keys will be skipped if API keys are not available.
No mocks are used - tests use real classes and code only.
"""

import os
import pytest

from elizaos_plugin_polymarket.actions import markets


# Skip entire module if API keys not available
pytestmark = pytest.mark.skipif(
    not os.environ.get("POLYMARKET_API_KEY"),
    reason="Polymarket API key not available - skipping API tests"
)


class TestGetMarkets:
    """Tests for get_markets action."""

    @pytest.mark.asyncio
    async def test_get_markets_returns_response(self) -> None:
        """Test that get_markets returns a valid response."""
        response = await markets.get_markets()
        assert hasattr(response, "data")
        assert hasattr(response, "count")
        assert hasattr(response, "limit")


class TestGetSimplifiedMarkets:
    """Tests for get_simplified_markets action."""

    @pytest.mark.asyncio
    async def test_get_simplified_markets_returns_response(self) -> None:
        """Test that get_simplified_markets returns a valid response."""
        response = await markets.get_simplified_markets()
        assert hasattr(response, "data")
        assert hasattr(response, "count")


class TestGetOpenMarkets:
    """Tests for get_open_markets action."""

    @pytest.mark.asyncio
    async def test_get_open_markets_returns_response(self) -> None:
        """Test that get_open_markets returns a valid response."""
        response = await markets.get_open_markets()
        assert hasattr(response, "data")
        # All returned markets should be open (active and not closed)
        for market in response.data:
            assert market.active is True
            assert market.closed is False
