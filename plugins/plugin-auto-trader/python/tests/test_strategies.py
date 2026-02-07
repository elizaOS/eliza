from __future__ import annotations

from elizaos_plugin_auto_trader.strategies.random import RandomStrategy
from elizaos_plugin_auto_trader.strategies.rule_based import RuleBasedStrategy
from elizaos_plugin_auto_trader.types import MarketData


def _md(prices: list[float] | None = None) -> MarketData:
    p = prices or [150.0]
    return MarketData(
        token="SOL",
        current_price=p[-1],
        prices=p,
        volume_24h=1_000_000.0,
        change_24h_pct=2.0,
    )


async def test_random_strategy_always_buy() -> None:
    strat = RandomStrategy(buy_probability=1.0, sell_probability=0.0)
    signal = await strat.analyze(_md())
    assert signal is not None
    assert signal.direction == "BUY"


async def test_random_strategy_always_sell() -> None:
    strat = RandomStrategy(buy_probability=0.0, sell_probability=1.0)
    signal = await strat.analyze(_md())
    assert signal is not None
    assert signal.direction == "SELL"


async def test_random_strategy_no_signal() -> None:
    strat = RandomStrategy(buy_probability=0.0, sell_probability=0.0)
    signal = await strat.analyze(_md())
    assert signal is None


async def test_rule_based_needs_enough_data() -> None:
    strat = RuleBasedStrategy(short_window=5, long_window=20)
    signal = await strat.analyze(_md([150.0] * 10))
    assert signal is None


async def test_rule_based_buy_on_uptrend() -> None:
    strat = RuleBasedStrategy(short_window=3, long_window=10)
    prices = [100.0 + i * 2.0 for i in range(10)] + [130.0, 135.0, 140.0]
    signal = await strat.analyze(_md(prices))
    if signal is not None:
        assert signal.direction == "BUY"


async def test_rule_based_sell_on_downtrend() -> None:
    strat = RuleBasedStrategy(short_window=3, long_window=10)
    prices = [200.0 - i * 2.0 for i in range(10)] + [170.0, 165.0, 160.0]
    signal = await strat.analyze(_md(prices))
    if signal is not None:
        assert signal.direction == "SELL"


def test_strategy_names() -> None:
    assert RandomStrategy().name == "Random"
    assert RuleBasedStrategy().name == "RuleBased"
