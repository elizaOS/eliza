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
from elizaos_plugin_auto_trader.portfolio import PortfolioManager
from elizaos_plugin_auto_trader.providers import PortfolioStatusProvider
from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.strategies import RandomStrategy, RuleBasedStrategy
from elizaos_plugin_auto_trader.types import (
    BacktestResult,
    Holding,
    MarketAnalysis,
    MarketData,
    PerformanceReport,
    Portfolio,
    StrategyConfig,
    Trade,
    TradeSignal,
    TradingConfig,
    TradingStrategy,
)

__version__ = "2.0.0"

PLUGIN_NAME = "auto-trader"
PLUGIN_DESCRIPTION = (
    "Automated trading with multiple strategies, backtesting, and risk management"
)

__all__ = [
    # Service
    "TradingService",
    "TradingConfig",
    # Portfolio
    "PortfolioManager",
    # Types
    "TradingStrategy",
    "StrategyConfig",
    "Trade",
    "Holding",
    "Portfolio",
    "BacktestResult",
    "MarketAnalysis",
    "PerformanceReport",
    "TradeSignal",
    "MarketData",
    # Strategies
    "RandomStrategy",
    "RuleBasedStrategy",
    # Actions
    "StartTradingAction",
    "StopTradingAction",
    "CheckPortfolioAction",
    "RunBacktestAction",
    "CompareStrategiesAction",
    "AnalyzePerformanceAction",
    "GetMarketAnalysisAction",
    "ConfigureStrategyAction",
    "ExecuteLiveTradeAction",
    # Providers
    "PortfolioStatusProvider",
    # Meta
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
