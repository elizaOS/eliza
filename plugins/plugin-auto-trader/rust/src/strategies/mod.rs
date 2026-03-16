pub mod random;
pub mod rule_based;

pub use random::RandomStrategy;
pub use rule_based::RuleBasedStrategy;

use async_trait::async_trait;

use crate::types::{MarketData, TradeSignal};

/// A trading strategy that can analyze market data and produce signals.
#[async_trait]
pub trait Strategy: Send + Sync {
    /// Human-readable name of the strategy.
    fn name(&self) -> &str;

    /// Analyze market data and optionally produce a trade signal.
    async fn analyze(&self, market_data: &MarketData) -> Option<TradeSignal>;
}
