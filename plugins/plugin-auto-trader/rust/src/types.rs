use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TradingStrategy {
    Random,
    RuleBased,
    LlmDriven,
}

impl std::fmt::Display for TradingStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Random => write!(f, "Random"),
            Self::RuleBased => write!(f, "RuleBased"),
            Self::LlmDriven => write!(f, "LLMDriven"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyConfig {
    pub strategy: TradingStrategy,
    pub risk_level: f64,
    pub max_position_size: f64,
    pub stop_loss_pct: f64,
    pub take_profit_pct: f64,
    pub max_daily_trades: u32,
}

impl Default for StrategyConfig {
    fn default() -> Self {
        Self {
            strategy: TradingStrategy::Random,
            risk_level: 0.5,
            max_position_size: 0.1,
            stop_loss_pct: 5.0,
            take_profit_pct: 15.0,
            max_daily_trades: 10,
        }
    }
}

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TradeDirection {
    Buy,
    Sell,
}

impl std::fmt::Display for TradeDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Buy => write!(f, "BUY"),
            Self::Sell => write!(f, "SELL"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TradeStatus {
    Pending,
    Executed,
    Cancelled,
    Failed,
}

impl std::fmt::Display for TradeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "Pending"),
            Self::Executed => write!(f, "Executed"),
            Self::Cancelled => write!(f, "Cancelled"),
            Self::Failed => write!(f, "Failed"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub token: String,
    pub direction: TradeDirection,
    pub amount: f64,
    pub price: f64,
    pub timestamp: DateTime<Utc>,
    pub strategy: TradingStrategy,
    pub status: TradeStatus,
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Holding {
    pub token: String,
    pub amount: f64,
    pub avg_price: f64,
    pub current_price: f64,
    pub value: f64,
    pub pnl: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Portfolio {
    pub holdings: HashMap<String, Holding>,
    pub total_value: f64,
    pub pnl: f64,
    pub pnl_pct: f64,
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestResult {
    pub strategy: TradingStrategy,
    pub period_days: u32,
    pub trades: Vec<Trade>,
    pub total_pnl: f64,
    pub win_rate: f64,
    pub max_drawdown: f64,
    pub sharpe_ratio: f64,
}

// ---------------------------------------------------------------------------
// Market analysis
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketTrend {
    Bullish,
    Bearish,
    Neutral,
}

impl std::fmt::Display for MarketTrend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bullish => write!(f, "Bullish"),
            Self::Bearish => write!(f, "Bearish"),
            Self::Neutral => write!(f, "Neutral"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Recommendation {
    StrongBuy,
    Buy,
    Hold,
    Sell,
    StrongSell,
}

impl std::fmt::Display for Recommendation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StrongBuy => write!(f, "StrongBuy"),
            Self::Buy => write!(f, "Buy"),
            Self::Hold => write!(f, "Hold"),
            Self::Sell => write!(f, "Sell"),
            Self::StrongSell => write!(f, "StrongSell"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketAnalysis {
    pub token: String,
    pub trend: MarketTrend,
    pub support: f64,
    pub resistance: f64,
    pub volume_24h: f64,
    pub recommendation: Recommendation,
}

// ---------------------------------------------------------------------------
// Performance report
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceReport {
    pub total_trades: u64,
    pub winning_trades: u64,
    pub losing_trades: u64,
    pub total_pnl: f64,
    pub total_pnl_pct: f64,
    pub win_rate: f64,
    pub avg_win: f64,
    pub avg_loss: f64,
    pub max_drawdown: f64,
    pub sharpe_ratio: f64,
}

// ---------------------------------------------------------------------------
// Trading state & config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TradingState {
    Running,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradingConfig {
    pub enabled: bool,
    pub use_mock_exchange: bool,
    pub max_portfolio_value: f64,
    pub rebalance_interval_ms: u64,
}

impl Default for TradingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            use_mock_exchange: true,
            max_portfolio_value: 10_000.0,
            rebalance_interval_ms: 60_000,
        }
    }
}

// ---------------------------------------------------------------------------
// Trade signal (used by strategies)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeSignal {
    pub token: String,
    pub direction: TradeDirection,
    pub strength: f64,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Market data (input to strategies)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketData {
    pub token: String,
    pub current_price: f64,
    pub prices: Vec<f64>,
    pub volume_24h: f64,
    pub change_24h_pct: f64,
}
