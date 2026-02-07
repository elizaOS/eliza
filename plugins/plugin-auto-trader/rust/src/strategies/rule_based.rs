use async_trait::async_trait;

use super::Strategy;
use crate::types::{MarketData, TradeDirection, TradeSignal};

/// Simple moving-average crossover strategy (simulated).
///
/// Uses a short and long window over the price history to detect crossovers.
/// When the short MA crosses **above** the long MA → buy signal.
/// When the short MA crosses **below** the long MA → sell signal.
pub struct RuleBasedStrategy {
    pub short_window: usize,
    pub long_window: usize,
}

impl Default for RuleBasedStrategy {
    fn default() -> Self {
        Self {
            short_window: 5,
            long_window: 20,
        }
    }
}

impl RuleBasedStrategy {
    pub fn new(short_window: usize, long_window: usize) -> Self {
        Self {
            short_window: short_window.max(1),
            long_window: long_window.max(2),
        }
    }
}

fn moving_average(prices: &[f64], window: usize) -> Option<f64> {
    if prices.len() < window || window == 0 {
        return None;
    }
    let slice = &prices[prices.len() - window..];
    Some(slice.iter().sum::<f64>() / window as f64)
}

#[async_trait]
impl Strategy for RuleBasedStrategy {
    fn name(&self) -> &str {
        "RuleBased"
    }

    async fn analyze(&self, market_data: &MarketData) -> Option<TradeSignal> {
        let prices = &market_data.prices;
        if prices.len() < self.long_window {
            return None;
        }

        let short_ma = moving_average(prices, self.short_window)?;
        let long_ma = moving_average(prices, self.long_window)?;

        // Avoid divide-by-zero
        if long_ma.abs() < f64::EPSILON {
            return None;
        }

        let diff_pct = (short_ma - long_ma) / long_ma * 100.0;

        if diff_pct > 1.0 {
            // Short MA above long MA → bullish crossover
            Some(TradeSignal {
                token: market_data.token.clone(),
                direction: TradeDirection::Buy,
                strength: (diff_pct / 10.0).min(1.0),
                reason: format!(
                    "SMA crossover: short({})={:.2} > long({})={:.2} ({:+.2}%)",
                    self.short_window, short_ma, self.long_window, long_ma, diff_pct
                ),
            })
        } else if diff_pct < -1.0 {
            // Short MA below long MA → bearish crossover
            Some(TradeSignal {
                token: market_data.token.clone(),
                direction: TradeDirection::Sell,
                strength: (diff_pct.abs() / 10.0).min(1.0),
                reason: format!(
                    "SMA crossover: short({})={:.2} < long({})={:.2} ({:+.2}%)",
                    self.short_window, short_ma, self.long_window, long_ma, diff_pct
                ),
            })
        } else {
            None
        }
    }
}
