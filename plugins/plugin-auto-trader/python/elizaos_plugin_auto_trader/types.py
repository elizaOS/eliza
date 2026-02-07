from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Literal


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------


class TradingStrategy(str, Enum):
    RANDOM = "random"
    RULE_BASED = "rule_based"
    LLM_DRIVEN = "llm_driven"


@dataclass
class StrategyConfig:
    strategy: TradingStrategy = TradingStrategy.RANDOM
    risk_level: float = 0.5
    max_position_size: float = 0.1
    stop_loss_pct: float = 5.0
    take_profit_pct: float = 15.0
    max_daily_trades: int = 10


# ---------------------------------------------------------------------------
# Trade
# ---------------------------------------------------------------------------

TradeDirection = Literal["BUY", "SELL"]
TradeStatusType = Literal["Pending", "Executed", "Cancelled", "Failed"]


@dataclass
class Trade:
    id: str
    token: str
    direction: TradeDirection
    amount: float
    price: float
    timestamp: datetime
    strategy: TradingStrategy
    status: TradeStatusType


# ---------------------------------------------------------------------------
# Portfolio
# ---------------------------------------------------------------------------


@dataclass
class Holding:
    token: str
    amount: float
    avg_price: float
    current_price: float
    value: float
    pnl: float


@dataclass
class Portfolio:
    holdings: dict[str, Holding] = field(default_factory=dict)
    total_value: float = 0.0
    pnl: float = 0.0
    pnl_pct: float = 0.0


# ---------------------------------------------------------------------------
# Backtest
# ---------------------------------------------------------------------------


@dataclass
class BacktestResult:
    strategy: TradingStrategy
    period_days: int
    trades: list[Trade]
    total_pnl: float
    win_rate: float
    max_drawdown: float
    sharpe_ratio: float


# ---------------------------------------------------------------------------
# Market analysis
# ---------------------------------------------------------------------------

MarketTrend = Literal["Bullish", "Bearish", "Neutral"]
Recommendation = Literal["StrongBuy", "Buy", "Hold", "Sell", "StrongSell"]


@dataclass
class MarketAnalysis:
    token: str
    trend: MarketTrend
    support: float
    resistance: float
    volume_24h: float
    recommendation: Recommendation


# ---------------------------------------------------------------------------
# Performance report
# ---------------------------------------------------------------------------


@dataclass
class PerformanceReport:
    total_trades: int
    winning_trades: int
    losing_trades: int
    total_pnl: float
    total_pnl_pct: float
    win_rate: float
    avg_win: float
    avg_loss: float
    max_drawdown: float
    sharpe_ratio: float


# ---------------------------------------------------------------------------
# Trading state & config
# ---------------------------------------------------------------------------

TradingState = Literal["Running", "Stopped"]


@dataclass
class TradingConfig:
    enabled: bool = True
    use_mock_exchange: bool = True
    max_portfolio_value: float = 10_000.0
    rebalance_interval_ms: int = 60_000


# ---------------------------------------------------------------------------
# Trade signal (used by strategies)
# ---------------------------------------------------------------------------


@dataclass
class TradeSignal:
    token: str
    direction: TradeDirection
    strength: float
    reason: str


# ---------------------------------------------------------------------------
# Market data (input to strategies)
# ---------------------------------------------------------------------------


@dataclass
class MarketData:
    token: str
    current_price: float
    prices: list[float]
    volume_24h: float
    change_24h_pct: float
