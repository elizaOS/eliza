use std::collections::HashMap;

use crate::types::{Holding, Portfolio, Trade, TradeDirection, TradeStatus};

/// Manages an in-memory portfolio: holdings and trade history.
pub struct PortfolioManager {
    holdings: HashMap<String, Holding>,
    trade_history: Vec<Trade>,
    initial_value: f64,
}

impl PortfolioManager {
    pub fn new(initial_value: f64) -> Self {
        Self {
            holdings: HashMap::new(),
            trade_history: Vec::new(),
            initial_value,
        }
    }

    /// Return a snapshot of the current portfolio.
    pub fn get_portfolio(&self) -> Portfolio {
        let total_value: f64 = self.holdings.values().map(|h| h.value).sum();
        let cost_basis: f64 = self
            .holdings
            .values()
            .map(|h| h.avg_price * h.amount)
            .sum();
        let pnl = total_value - cost_basis;
        let pnl_pct = if cost_basis.abs() > f64::EPSILON {
            pnl / cost_basis * 100.0
        } else {
            0.0
        };

        Portfolio {
            holdings: self.holdings.clone(),
            total_value,
            pnl,
            pnl_pct,
        }
    }

    /// Update (or create) a holding for the given token.
    pub fn update_holding(&mut self, token: &str, amount: f64, price: f64) {
        let holding = self.holdings.entry(token.to_string()).or_insert(Holding {
            token: token.to_string(),
            amount: 0.0,
            avg_price: 0.0,
            current_price: price,
            value: 0.0,
            pnl: 0.0,
        });

        if amount > 0.0 {
            // Weighted average price
            let total_cost = holding.avg_price * holding.amount + price * amount;
            holding.amount += amount;
            if holding.amount > f64::EPSILON {
                holding.avg_price = total_cost / holding.amount;
            }
        } else {
            // Reducing position
            holding.amount = (holding.amount + amount).max(0.0);
        }

        holding.current_price = price;
        holding.value = holding.amount * holding.current_price;
        holding.pnl = (holding.current_price - holding.avg_price) * holding.amount;

        // Remove holdings with zero amount
        if holding.amount < f64::EPSILON {
            self.holdings.remove(token);
        }
    }

    /// Update the current price for a token without changing the amount.
    pub fn update_price(&mut self, token: &str, price: f64) {
        if let Some(h) = self.holdings.get_mut(token) {
            h.current_price = price;
            h.value = h.amount * price;
            h.pnl = (price - h.avg_price) * h.amount;
        }
    }

    /// Record a completed trade.
    pub fn record_trade(&mut self, trade: Trade) {
        if trade.status == TradeStatus::Executed {
            match trade.direction {
                TradeDirection::Buy => {
                    self.update_holding(&trade.token, trade.amount, trade.price);
                }
                TradeDirection::Sell => {
                    self.update_holding(&trade.token, -trade.amount, trade.price);
                }
            }
        }
        self.trade_history.push(trade);
    }

    /// Return the most recent `limit` trades (or all if limit is 0).
    pub fn get_trade_history(&self, limit: usize) -> Vec<Trade> {
        if limit == 0 || limit >= self.trade_history.len() {
            return self.trade_history.clone();
        }
        self.trade_history[self.trade_history.len() - limit..].to_vec()
    }

    /// Calculate total PnL: (absolute, percentage).
    pub fn calculate_pnl(&self) -> (f64, f64) {
        let portfolio = self.get_portfolio();
        let pnl = portfolio.pnl;
        let pnl_pct = if self.initial_value.abs() > f64::EPSILON {
            pnl / self.initial_value * 100.0
        } else {
            portfolio.pnl_pct
        };
        (pnl, pnl_pct)
    }

    /// Number of holdings currently tracked.
    pub fn holdings_count(&self) -> usize {
        self.holdings.len()
    }

    /// Total number of trades recorded.
    pub fn trade_count(&self) -> usize {
        self.trade_history.len()
    }
}
