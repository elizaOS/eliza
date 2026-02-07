from __future__ import annotations

import pytest

from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.types import StrategyConfig, TradingConfig, TradingStrategy


async def test_initial_state_stopped(service: TradingService) -> None:
    assert await service.get_state() == "Stopped"


async def test_start_trading(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    assert await service.get_state() == "Running"


async def test_start_trading_already_running(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    with pytest.raises(RuntimeError, match="already running"):
        await service.start_trading(StrategyConfig())


async def test_stop_trading(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    await service.stop_trading()
    assert await service.get_state() == "Stopped"


async def test_stop_when_not_running(service: TradingService) -> None:
    with pytest.raises(RuntimeError, match="not running"):
        await service.stop_trading()


async def test_execute_trade_buy(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    trade = await service.execute_trade("SOL", "BUY", 10.0)
    assert trade.direction == "BUY"
    assert trade.token == "SOL"
    assert trade.status == "Executed"
    assert trade.price > 0


async def test_execute_trade_sell(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    await service.execute_trade("ETH", "BUY", 5.0)
    trade = await service.execute_trade("ETH", "SELL", 2.0)
    assert trade.direction == "SELL"


async def test_portfolio_after_trades(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    await service.execute_trade("SOL", "BUY", 10.0)
    portfolio = await service.check_portfolio()
    assert portfolio.total_value > 0
    assert "SOL" in portfolio.holdings


async def test_daily_trade_limit(service: TradingService) -> None:
    cfg = StrategyConfig(max_daily_trades=2)
    await service.start_trading(cfg)
    await service.execute_trade("SOL", "BUY", 1.0)
    await service.execute_trade("SOL", "BUY", 1.0)
    with pytest.raises(RuntimeError, match="Daily trade limit"):
        await service.execute_trade("SOL", "BUY", 1.0)


async def test_disabled_rejects_trades(disabled_service: TradingService) -> None:
    await disabled_service.start_trading(StrategyConfig())
    with pytest.raises(RuntimeError, match="disabled"):
        await disabled_service.execute_trade("SOL", "BUY", 1.0)


async def test_backtest_random(service: TradingService) -> None:
    result = await service.run_backtest(TradingStrategy.RANDOM, 7)
    assert result.strategy == TradingStrategy.RANDOM
    assert result.period_days == 7
    assert 0 <= result.win_rate <= 1.0
    assert result.max_drawdown >= 0


async def test_backtest_rule_based(service: TradingService) -> None:
    result = await service.run_backtest(TradingStrategy.RULE_BASED, 14)
    assert result.strategy == TradingStrategy.RULE_BASED
    assert result.period_days == 14


async def test_compare_strategies(service: TradingService) -> None:
    strategies = [TradingStrategy.RANDOM, TradingStrategy.RULE_BASED]
    results = await service.compare_strategies(strategies, 7)
    assert len(results) == 2
    assert results[0].strategy == TradingStrategy.RANDOM
    assert results[1].strategy == TradingStrategy.RULE_BASED


async def test_market_analysis_known_token(service: TradingService) -> None:
    analysis = await service.get_market_analysis("SOL")
    assert analysis.token == "SOL"
    assert analysis.support > 0
    assert analysis.resistance > analysis.support
    assert analysis.volume_24h > 0


async def test_market_analysis_unknown_token(service: TradingService) -> None:
    analysis = await service.get_market_analysis("UNKNOWN")
    assert analysis.token == "UNKNOWN"
    assert analysis.support > 0


async def test_configure_strategy_valid(service: TradingService) -> None:
    cfg = StrategyConfig(
        strategy=TradingStrategy.RULE_BASED,
        risk_level=0.8,
        max_position_size=0.2,
        stop_loss_pct=3.0,
        take_profit_pct=10.0,
        max_daily_trades=5,
    )
    await service.configure_strategy(cfg)
    stored = await service.get_strategy_config()
    assert stored.strategy == TradingStrategy.RULE_BASED
    assert abs(stored.risk_level - 0.8) < 1e-12


async def test_configure_strategy_invalid_risk(service: TradingService) -> None:
    with pytest.raises(ValueError, match="risk_level"):
        await service.configure_strategy(StrategyConfig(risk_level=1.5))


async def test_configure_strategy_invalid_position_size(service: TradingService) -> None:
    with pytest.raises(ValueError, match="max_position_size"):
        await service.configure_strategy(StrategyConfig(max_position_size=0.0))


async def test_configure_strategy_invalid_stop_loss(service: TradingService) -> None:
    with pytest.raises(ValueError, match="stop_loss_pct"):
        await service.configure_strategy(StrategyConfig(stop_loss_pct=-1.0))


async def test_performance_report_empty(service: TradingService) -> None:
    report = await service.analyze_performance()
    assert report.total_trades == 0
    assert report.winning_trades == 0


async def test_performance_report_after_trades(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    await service.execute_trade("SOL", "BUY", 10.0)
    await service.execute_trade("ETH", "BUY", 2.0)
    report = await service.analyze_performance()
    assert report.total_trades == 2


async def test_full_trading_lifecycle(service: TradingService) -> None:
    # Start
    await service.start_trading(StrategyConfig())
    assert await service.get_state() == "Running"

    # Execute trades
    await service.execute_trade("SOL", "BUY", 10.0)
    await service.execute_trade("ETH", "BUY", 5.0)

    # Check portfolio
    portfolio = await service.check_portfolio()
    assert len(portfolio.holdings) >= 2
    assert portfolio.total_value > 0

    # Check history
    history = await service.get_trade_history(10)
    assert len(history) == 2

    # Stop
    await service.stop_trading()
    assert await service.get_state() == "Stopped"
