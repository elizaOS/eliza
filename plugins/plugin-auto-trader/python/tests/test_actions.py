from __future__ import annotations

from elizaos_plugin_auto_trader.actions import (
    AnalyzePerformanceAction,
    CheckPortfolioAction,
    CompareStrategiesAction,
    ConfigureStrategyAction,
    ExecuteLiveTradeAction,
    GetMarketAnalysisAction,
    RunBacktestAction,
    StartTradingAction,
    StopTradingAction,
)
from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.types import StrategyConfig


def _msg(text: str = "") -> dict:
    return {"content": {"text": text}, "room_id": "room-1", "agent_id": "agent-1"}


# ── StartTradingAction ──────────────────────────────────────────────────────


async def test_start_trading_validate_positive(service: TradingService) -> None:
    action = StartTradingAction()
    assert await action.validate(_msg("start trading with random"), {})


async def test_start_trading_validate_negative(service: TradingService) -> None:
    action = StartTradingAction()
    assert not await action.validate(_msg("check portfolio"), {})


async def test_start_trading_handler(service: TradingService) -> None:
    action = StartTradingAction()
    result = await action.handler(_msg("start trading"), {}, service)
    assert result.success
    assert "started" in result.text


async def test_start_trading_no_service() -> None:
    action = StartTradingAction()
    result = await action.handler(_msg("start"), {}, None)
    assert not result.success
    assert result.error == "missing_service"


# ── StopTradingAction ───────────────────────────────────────────────────────


async def test_stop_trading_handler(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    action = StopTradingAction()
    result = await action.handler(_msg("stop trading"), {}, service)
    assert result.success
    assert "stopped" in result.text


async def test_stop_trading_when_not_running(service: TradingService) -> None:
    action = StopTradingAction()
    result = await action.handler(_msg("stop"), {}, service)
    assert not result.success


# ── CheckPortfolioAction ────────────────────────────────────────────────────


async def test_check_portfolio_handler(service: TradingService) -> None:
    action = CheckPortfolioAction()
    result = await action.handler(_msg("check portfolio"), {}, service)
    assert result.success
    assert "Portfolio" in result.text


# ── RunBacktestAction ───────────────────────────────────────────────────────


async def test_run_backtest_handler(service: TradingService) -> None:
    action = RunBacktestAction()
    result = await action.handler(_msg("backtest"), {"strategy": "random", "period_days": 7}, service)
    assert result.success
    assert "Backtest" in result.text


# ── CompareStrategiesAction ─────────────────────────────────────────────────


async def test_compare_strategies_handler(service: TradingService) -> None:
    action = CompareStrategiesAction()
    result = await action.handler(_msg("compare"), {"period_days": 7}, service)
    assert result.success
    assert "Comparison" in result.text


# ── AnalyzePerformanceAction ────────────────────────────────────────────────


async def test_analyze_performance_handler(service: TradingService) -> None:
    action = AnalyzePerformanceAction()
    result = await action.handler(_msg("performance"), {}, service)
    assert result.success
    assert "Performance" in result.text


# ── GetMarketAnalysisAction ─────────────────────────────────────────────────


async def test_get_market_analysis_handler(service: TradingService) -> None:
    action = GetMarketAnalysisAction()
    result = await action.handler(_msg("analyze SOL"), {"token": "SOL"}, service)
    assert result.success
    assert "SOL" in result.text


# ── ConfigureStrategyAction ─────────────────────────────────────────────────


async def test_configure_strategy_handler(service: TradingService) -> None:
    action = ConfigureStrategyAction()
    result = await action.handler(
        _msg("configure"),
        {"strategy": "rule_based", "risk_level": 0.7},
        service,
    )
    assert result.success
    assert "configured" in result.text


async def test_configure_strategy_invalid(service: TradingService) -> None:
    action = ConfigureStrategyAction()
    result = await action.handler(
        _msg("configure"),
        {"risk_level": 2.0},
        service,
    )
    assert not result.success


# ── ExecuteLiveTradeAction ──────────────────────────────────────────────────


async def test_execute_live_trade_buy(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    action = ExecuteLiveTradeAction()
    result = await action.handler(
        _msg("buy SOL"),
        {"token": "SOL", "amount": 5.0, "direction": "buy"},
        service,
    )
    assert result.success
    assert "BUY" in result.text


async def test_execute_live_trade_sell(service: TradingService) -> None:
    await service.start_trading(StrategyConfig())
    await service.execute_trade("ETH", "BUY", 10.0)
    action = ExecuteLiveTradeAction()
    result = await action.handler(
        _msg("sell ETH"),
        {"token": "ETH", "amount": 3.0, "direction": "sell"},
        service,
    )
    assert result.success
    assert "SELL" in result.text


async def test_execute_live_trade_no_service() -> None:
    action = ExecuteLiveTradeAction()
    result = await action.handler(_msg("buy SOL"), {"token": "SOL"}, None)
    assert not result.success
    assert result.error == "missing_service"
