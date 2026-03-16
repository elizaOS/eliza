use async_trait::async_trait;
use rand::Rng;

use super::Strategy;
use crate::types::{MarketData, TradeDirection, TradeSignal};

/// A random strategy that generates buy/sell signals with configurable
/// probability.  Useful as a baseline or for testing.
pub struct RandomStrategy {
    pub buy_probability: f64,
    pub sell_probability: f64,
}

impl Default for RandomStrategy {
    fn default() -> Self {
        Self {
            buy_probability: 0.3,
            sell_probability: 0.3,
        }
    }
}

impl RandomStrategy {
    pub fn new(buy_probability: f64, sell_probability: f64) -> Self {
        Self {
            buy_probability: buy_probability.clamp(0.0, 1.0),
            sell_probability: sell_probability.clamp(0.0, 1.0),
        }
    }
}

#[async_trait]
impl Strategy for RandomStrategy {
    fn name(&self) -> &str {
        "Random"
    }

    async fn analyze(&self, market_data: &MarketData) -> Option<TradeSignal> {
        let mut rng = rand::thread_rng();
        let roll: f64 = rng.gen();

        if roll < self.buy_probability {
            Some(TradeSignal {
                token: market_data.token.clone(),
                direction: TradeDirection::Buy,
                strength: roll / self.buy_probability,
                reason: "Random buy signal".to_string(),
            })
        } else if roll < self.buy_probability + self.sell_probability {
            Some(TradeSignal {
                token: market_data.token.clone(),
                direction: TradeDirection::Sell,
                strength: (roll - self.buy_probability) / self.sell_probability,
                reason: "Random sell signal".to_string(),
            })
        } else {
            None
        }
    }
}
