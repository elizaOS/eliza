from __future__ import annotations

import logging
import math
import random
import uuid
from datetime import datetime, timezone

from elizaos_plugin_auto_trader.portfolio import PortfolioManager
from elizaos_plugin_auto_trader.strategies.random import RandomStrategy
from elizaos_plugin_auto_trader.strategies.rule_based import RuleBasedStrategy
from elizaos_plugin_auto_trader.types import (
    BacktestResult,
    MarketAnalysis,
    MarketData,
    PerformanceReport,
    StrategyConfig,
    Trade,
    TradingConfig,
    TradingStrategy,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Mock exchange
# ---------------------------------------------------------------------------

_MOCK_PRICES: dict[str, float] = {
    "SOL": 150.0,
    "BTC": 45_000.0,
    "ETH": 2_500.0,
    "BONK": 0.00001,
    "WIF": 2.5,
}


def _get_price(token: str) -> float:
    return _MOCK_PRICES.get(token, 100.0)


def _jitter_price(base: float) -> float:
    factor = 1.0 + random.uniform(-0.05, 0.05)
    return base * factor


# ---------------------------------------------------------------------------
# TradingService
# ---------------------------------------------------------------------------


class TradingService:
    """Core trading service — orchestrates strategies, portfolio, and the
    mock exchange."""

    def __init__(self, config: TradingConfig | None = None) -> None:
        self._config = config or TradingConfig()
        self._strategy_config = StrategyConfig()
        self._state: str = "Stopped"
        self._portfolio = PortfolioManager(10_000.0)
        self._daily_trade_count = 0
        logger.info(
            "TradingService initialized (mock_exchange=%s)",
            self._config.use_mock_exchange,
        )

    # -- lifecycle -----------------------------------------------------------

    async def start_trading(self, strategy_config: StrategyConfig) -> None:
        if self._state == "Running":
            raise RuntimeError("Trading is already running")
        self._strategy_config = strategy_config
        self._daily_trade_count = 0
        self._state = "Running"
        logger.info("Trading started")

    async def stop_trading(self) -> None:
        if self._state == "Stopped":
            raise RuntimeError("Trading is not running")
        self._state = "Stopped"
        logger.info("Trading stopped")

    async def get_state(self) -> str:
        return self._state

    # -- trade execution -----------------------------------------------------

    async def execute_trade(
        self,
        token: str,
        direction: str,
        amount: float,
    ) -> Trade:
        if not self._config.enabled:
            raise RuntimeError("Trading is disabled")

        if self._daily_trade_count >= self._strategy_config.max_daily_trades:
            raise RuntimeError(
                f"Daily trade limit reached ({self._daily_trade_count}"
                f"/{self._strategy_config.max_daily_trades})"
            )

        # Check stop-loss
        _pnl, pnl_pct = self._portfolio.calculate_pnl()
        if pnl_pct < -self._strategy_config.stop_loss_pct:
            raise RuntimeError(
                f"Stop loss triggered: PnL {pnl_pct:.2f}% exceeds "
                f"-{self._strategy_config.stop_loss_pct:.2f}% threshold"
            )

        base_price = _get_price(token)
        exec_price = _jitter_price(base_price) if self._config.use_mock_exchange else base_price

        trade = Trade(
            id=str(uuid.uuid4()),
            token=token,
            direction=direction,
            amount=amount,
            price=exec_price,
            timestamp=datetime.now(timezone.utc),
            strategy=self._strategy_config.strategy,
            status="Executed",
        )

        self._portfolio.record_trade(trade)
        self._daily_trade_count += 1

        logger.info("Trade executed: %s %s %s @ %.4f", direction, amount, token, exec_price)
        return trade

    # -- portfolio -----------------------------------------------------------

    async def check_portfolio(self) -> dict[str, object]:
        return self._portfolio.get_portfolio()

    async def get_trade_history(self, limit: int = 0) -> list[Trade]:
        return self._portfolio.get_trade_history(limit)

    # -- backtest ------------------------------------------------------------

    async def run_backtest(
        self,
        strategy: TradingStrategy,
        period_days: int,
    ) -> BacktestResult:
        num_candles = period_days * 24

        # Synthetic price series
        prices: list[float] = []
        price = 100.0
        for _ in range(num_candles):
            price *= 1.0 + random.uniform(-0.02, 0.02)
            price = max(1.0, price)
            prices.append(price)

        # Pick strategy
        if strategy == TradingStrategy.RULE_BASED:
            strat = RuleBasedStrategy()
        elif strategy == TradingStrategy.LLM_DRIVEN:
            strat = RandomStrategy(buy_probability=0.25, sell_probability=0.25)
        else:
            strat = RandomStrategy(buy_probability=0.3, sell_probability=0.3)

        trades: list[Trade] = []
        capital = 10_000.0
        position = 0.0
        peak = capital
        max_drawdown = 0.0

        window = min(25, len(prices))
        for i in range(window, len(prices)):
            slc = prices[i - window : i + 1]
            md = MarketData(
                token="BACKTEST",
                current_price=prices[i],
                prices=slc,
                volume_24h=1_000_000.0,
                change_24h_pct=(
                    (prices[i] - prices[i - 1]) / prices[i - 1] * 100.0 if i > 0 else 0.0
                ),
            )

            signal = await strat.analyze(md)
            if signal is not None:
                trade_amount = (capital * 0.1) / prices[i]
                trade = Trade(
                    id=str(uuid.uuid4()),
                    token="BACKTEST",
                    direction=signal.direction,
                    amount=trade_amount,
                    price=prices[i],
                    timestamp=datetime.now(timezone.utc),
                    strategy=strategy,
                    status="Executed",
                )

                if signal.direction == "BUY" and capital >= trade_amount * prices[i]:
                    capital -= trade_amount * prices[i]
                    position += trade_amount
                    trades.append(trade)
                elif signal.direction == "SELL" and position >= trade_amount:
                    capital += trade_amount * prices[i]
                    position -= trade_amount
                    trades.append(trade)

            total = capital + position * prices[i]
            if total > peak:
                peak = total
            dd = (peak - total) / peak if peak > 0 else 0.0
            if dd > max_drawdown:
                max_drawdown = dd

        final_value = capital + position * (prices[-1] if prices else 100.0)
        total_pnl = final_value - 10_000.0
        winning = sum(
            1
            for t in trades
            if t.direction == "SELL" and t.price > (prices[0] if prices else 100.0)
        )
        win_rate = winning / len(trades) if trades else 0.0

        # Sharpe ratio
        returns = []
        for i in range(1, len(prices)):
            returns.append((prices[i] - prices[i - 1]) / prices[i - 1])
        mean_ret = sum(returns) / max(len(returns), 1)
        std_dev = math.sqrt(
            sum((r - mean_ret) ** 2 for r in returns) / max(len(returns), 1)
        )
        sharpe = (mean_ret / std_dev * math.sqrt(252)) if std_dev > 1e-12 else 0.0

        return BacktestResult(
            strategy=strategy,
            period_days=period_days,
            trades=trades,
            total_pnl=total_pnl,
            win_rate=win_rate,
            max_drawdown=max_drawdown,
            sharpe_ratio=sharpe,
        )

    async def compare_strategies(
        self,
        strategies: list[TradingStrategy],
        period_days: int,
    ) -> list[BacktestResult]:
        results: list[BacktestResult] = []
        for s in strategies:
            results.append(await self.run_backtest(s, period_days))
        return results

    # -- performance ---------------------------------------------------------

    async def analyze_performance(self) -> PerformanceReport:
        trades = self._portfolio.get_trade_history(0)
        pnl, pnl_pct = self._portfolio.calculate_pnl()

        winning = 0
        losing = 0
        win_sum = 0.0
        loss_sum = 0.0

        for t in trades:
            if t.status != "Executed":
                continue
            if t.direction == "SELL":
                trade_pnl = t.amount * (t.price - 100.0)
                if trade_pnl > 0:
                    winning += 1
                    win_sum += trade_pnl
                else:
                    losing += 1
                    loss_sum += abs(trade_pnl)

        total_decided = winning + losing
        win_rate = winning / total_decided if total_decided > 0 else 0.0

        return PerformanceReport(
            total_trades=len(trades),
            winning_trades=winning,
            losing_trades=losing,
            total_pnl=pnl,
            total_pnl_pct=pnl_pct,
            win_rate=win_rate,
            avg_win=win_sum / winning if winning > 0 else 0.0,
            avg_loss=loss_sum / losing if losing > 0 else 0.0,
            max_drawdown=0.0,
            sharpe_ratio=0.0,
        )

    # -- market analysis -----------------------------------------------------

    async def get_market_analysis(self, token: str) -> MarketAnalysis:
        base = _get_price(token)
        change = random.uniform(-5.0, 5.0)

        if change > 1.5:
            trend = "Bullish"
        elif change < -1.5:
            trend = "Bearish"
        else:
            trend = "Neutral"

        if trend == "Bullish":
            recommendation = "StrongBuy" if change > 3.0 else "Buy"
        elif trend == "Bearish":
            recommendation = "StrongSell" if change < -3.0 else "Sell"
        else:
            recommendation = "Hold"

        return MarketAnalysis(
            token=token,
            trend=trend,
            support=base * 0.95,
            resistance=base * 1.05,
            volume_24h=random.uniform(100_000.0, 10_000_000.0),
            recommendation=recommendation,
        )

    # -- strategy configuration ----------------------------------------------

    async def configure_strategy(self, config: StrategyConfig) -> None:
        if config.risk_level < 0.0 or config.risk_level > 1.0:
            raise ValueError("risk_level must be between 0.0 and 1.0")
        if config.max_position_size <= 0.0 or config.max_position_size > 1.0:
            raise ValueError("max_position_size must be between 0.0 and 1.0")
        if config.stop_loss_pct <= 0.0:
            raise ValueError("stop_loss_pct must be positive")
        self._strategy_config = config
        logger.info("Strategy reconfigured")

    async def get_strategy_config(self) -> StrategyConfig:
        return self._strategy_config
