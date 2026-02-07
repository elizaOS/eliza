#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

mod portfolio;
mod service;
mod types;

pub mod actions;
pub mod providers;
pub mod strategies;

pub use portfolio::PortfolioManager;
pub use service::TradingService;
pub use types::{
    BacktestResult, Holding, MarketAnalysis, MarketData, MarketTrend, PerformanceReport, Portfolio,
    Recommendation, StrategyConfig, Trade, TradeDirection, TradeSignal, TradeStatus,
    TradingConfig, TradingState, TradingStrategy,
};

pub use actions::get_trading_actions;
pub use providers::get_trading_providers;
pub use providers::PortfolioStatusProvider;

pub const PLUGIN_NAME: &str = "auto-trader";
pub const PLUGIN_DESCRIPTION: &str =
    "Automated trading with multiple strategies, backtesting, and risk management";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
pub struct ActionExample {
    pub user_message: String,
    pub agent_response: String,
}

#[derive(Debug, Clone)]
pub struct ActionResult {
    pub success: bool,
    pub text: String,
    pub data: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub values: Value,
    pub text: String,
    pub data: Value,
}

#[async_trait]
pub trait Action: Send + Sync {
    fn name(&self) -> &str;
    fn similes(&self) -> Vec<&str>;
    fn description(&self) -> &str;
    async fn validate(&self, message: &Value, state: &Value) -> bool;
    async fn handler(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&TradingService>,
    ) -> ActionResult;
    fn examples(&self) -> Vec<ActionExample>;
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn position(&self) -> i32;
    async fn get(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&TradingService>,
    ) -> ProviderResult;
}

pub mod prelude {
    pub use crate::actions::get_trading_actions;
    pub use crate::providers::{get_trading_providers, PortfolioStatusProvider};
    pub use crate::service::TradingService;
    pub use crate::strategies::{random::RandomStrategy, rule_based::RuleBasedStrategy, Strategy};
    pub use crate::types::{
        BacktestResult, Holding, MarketAnalysis, MarketData, MarketTrend, PerformanceReport,
        Portfolio, Recommendation, StrategyConfig, Trade, TradeDirection, TradeSignal, TradeStatus,
        TradingConfig, TradingState, TradingStrategy,
    };
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
    pub use crate::{PortfolioManager, PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};
}
