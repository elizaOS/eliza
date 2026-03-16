from __future__ import annotations

from datetime import datetime, timezone

from elizaos_plugin_auto_trader.portfolio import PortfolioManager
from elizaos_plugin_auto_trader.types import Trade, TradingStrategy


def _trade(
    token: str = "SOL",
    direction: str = "BUY",
    amount: float = 1.0,
    price: float = 100.0,
    status: str = "Executed",
) -> Trade:
    return Trade(
        id="t-1",
        token=token,
        direction=direction,
        amount=amount,
        price=price,
        timestamp=datetime.now(timezone.utc),
        strategy=TradingStrategy.RANDOM,
        status=status,
    )


def test_portfolio_new_empty() -> None:
    pm = PortfolioManager(10_000.0)
    p = pm.get_portfolio()
    assert len(p.holdings) == 0
    assert abs(p.total_value) < 1e-12


def test_portfolio_add_holding() -> None:
    pm = PortfolioManager(10_000.0)
    pm.update_holding("SOL", 10.0, 150.0)
    p = pm.get_portfolio()
    assert len(p.holdings) == 1
    h = p.holdings["SOL"]
    assert abs(h.amount - 10.0) < 1e-12
    assert abs(h.avg_price - 150.0) < 1e-12
    assert abs(h.value - 1500.0) < 1e-12


def test_portfolio_weighted_avg_price() -> None:
    pm = PortfolioManager(10_000.0)
    pm.update_holding("SOL", 10.0, 100.0)
    pm.update_holding("SOL", 10.0, 200.0)
    h = pm.get_portfolio().holdings["SOL"]
    assert abs(h.avg_price - 150.0) < 0.01
    assert abs(h.amount - 20.0) < 1e-12


def test_portfolio_sell_reduces_holding() -> None:
    pm = PortfolioManager(10_000.0)
    pm.update_holding("ETH", 5.0, 2500.0)
    pm.update_holding("ETH", -3.0, 2600.0)
    h = pm.get_portfolio().holdings["ETH"]
    assert abs(h.amount - 2.0) < 1e-12


def test_portfolio_sell_all_removes_holding() -> None:
    pm = PortfolioManager(10_000.0)
    pm.update_holding("BTC", 1.0, 45000.0)
    pm.update_holding("BTC", -1.0, 46000.0)
    assert pm.holdings_count == 0


def test_portfolio_pnl_calculation() -> None:
    pm = PortfolioManager(10_000.0)
    pm.update_holding("SOL", 10.0, 100.0)
    pm.update_price("SOL", 120.0)
    pnl, _ = pm.calculate_pnl()
    assert abs(pnl - 200.0) < 0.01


def test_portfolio_record_trade() -> None:
    pm = PortfolioManager(10_000.0)
    pm.record_trade(_trade("SOL", "BUY", 5.0, 150.0))
    assert pm.trade_count == 1
    assert pm.holdings_count == 1


def test_portfolio_trade_history_limit() -> None:
    pm = PortfolioManager(10_000.0)
    for i in range(10):
        pm.record_trade(_trade("SOL", "BUY", 1.0, 100.0 + i))
    assert len(pm.get_trade_history(0)) == 10
    assert len(pm.get_trade_history(3)) == 3
    assert len(pm.get_trade_history(100)) == 10


def test_portfolio_cancelled_trade_no_effect() -> None:
    pm = PortfolioManager(10_000.0)
    pm.record_trade(_trade("BTC", "BUY", 1.0, 45000.0, status="Cancelled"))
    assert pm.trade_count == 1
    assert pm.holdings_count == 0
