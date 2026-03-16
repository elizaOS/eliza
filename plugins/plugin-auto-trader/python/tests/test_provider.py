from __future__ import annotations

from elizaos_plugin_auto_trader.providers import PortfolioStatusProvider
from elizaos_plugin_auto_trader.service import TradingService


async def test_portfolio_provider_with_service(service: TradingService) -> None:
    provider = PortfolioStatusProvider()
    result = await provider.get(
        {"room_id": "r1", "content": {"text": ""}},
        {},
        service,
    )
    assert "Portfolio Status" in result.text
    assert "Stopped" in result.text


async def test_portfolio_provider_without_service() -> None:
    provider = PortfolioStatusProvider()
    result = await provider.get(
        {"room_id": "r1", "content": {"text": ""}},
        {},
        None,
    )
    assert "not available" in result.text
