use std::sync::Arc;

use chrono::Utc;
use rand::Rng;
use tokio::sync::Mutex;
use tracing::info;
use uuid::Uuid;

use crate::portfolio::PortfolioManager;
use crate::strategies::{random::RandomStrategy, rule_based::RuleBasedStrategy, Strategy};
use crate::types::{
    BacktestResult, MarketAnalysis, MarketData, MarketTrend, PerformanceReport, Recommendation,
    StrategyConfig, Trade, TradeDirection, TradeStatus, TradingConfig, TradingState,
    TradingStrategy,
};

/// Mock exchange prices for deterministic testing.
struct MockExchange;

impl MockExchange {
    fn get_price(token: &str) -> f64 {
        // Deterministic mock prices
        match token {
            "SOL" => 150.0,
            "BTC" => 45_000.0,
            "ETH" => 2_500.0,
            "BONK" => 0.00001,
            "WIF" => 2.5,
            _ => 100.0,
        }
    }

    fn jitter_price(base: f64) -> f64 {
        let mut rng = rand::thread_rng();
        let factor: f64 = 1.0 + rng.gen_range(-0.05..0.05);
        base * factor
    }
}

/// Core trading service — orchestrates strategies, portfolio, and the mock
/// exchange.
pub struct TradingService {
    config: TradingConfig,
    strategy_config: Arc<Mutex<StrategyConfig>>,
    state: Arc<Mutex<TradingState>>,
    portfolio: Arc<Mutex<PortfolioManager>>,
    daily_trade_count: Arc<Mutex<u32>>,
}

impl TradingService {
    pub fn new(config: TradingConfig) -> Self {
        info!("TradingService initialized (mock_exchange={})", config.use_mock_exchange);
        Self {
            config,
            strategy_config: Arc::new(Mutex::new(StrategyConfig::default())),
            state: Arc::new(Mutex::new(TradingState::Stopped)),
            portfolio: Arc::new(Mutex::new(PortfolioManager::new(10_000.0))),
            daily_trade_count: Arc::new(Mutex::new(0)),
        }
    }

    // -- lifecycle -----------------------------------------------------------

    pub async fn start_trading(&self, strategy_config: StrategyConfig) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if *state == TradingState::Running {
            return Err("Trading is already running".to_string());
        }
        *self.strategy_config.lock().await = strategy_config;
        *self.daily_trade_count.lock().await = 0;
        *state = TradingState::Running;
        info!("Trading started");
        Ok(())
    }

    pub async fn stop_trading(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if *state == TradingState::Stopped {
            return Err("Trading is not running".to_string());
        }
        *state = TradingState::Stopped;
        info!("Trading stopped");
        Ok(())
    }

    pub async fn get_state(&self) -> TradingState {
        *self.state.lock().await
    }

    // -- trade execution -----------------------------------------------------

    pub async fn execute_trade(
        &self,
        token: &str,
        direction: TradeDirection,
        amount: f64,
    ) -> Result<Trade, String> {
        if !self.config.enabled {
            return Err("Trading is disabled".to_string());
        }

        // Check daily limit
        let cfg = self.strategy_config.lock().await;
        let mut daily = self.daily_trade_count.lock().await;
        if *daily >= cfg.max_daily_trades {
            return Err(format!(
                "Daily trade limit reached ({}/{})",
                *daily, cfg.max_daily_trades
            ));
        }

        // Check stop-loss / take-profit
        let portfolio = self.portfolio.lock().await;
        let (_pnl, pnl_pct) = portfolio.calculate_pnl();
        drop(portfolio);

        if pnl_pct < -cfg.stop_loss_pct {
            return Err(format!(
                "Stop loss triggered: PnL {:.2}% exceeds -{:.2}% threshold",
                pnl_pct, cfg.stop_loss_pct
            ));
        }

        // Mock exchange execution
        let base_price = MockExchange::get_price(token);
        let exec_price = if self.config.use_mock_exchange {
            MockExchange::jitter_price(base_price)
        } else {
            base_price
        };

        let trade = Trade {
            id: Uuid::new_v4().to_string(),
            token: token.to_string(),
            direction,
            amount,
            price: exec_price,
            timestamp: Utc::now(),
            strategy: cfg.strategy,
            status: TradeStatus::Executed,
        };

        // Record in portfolio
        self.portfolio.lock().await.record_trade(trade.clone());
        *daily += 1;

        info!(
            "Trade executed: {} {} {} @ {:.4}",
            direction, amount, token, exec_price
        );

        Ok(trade)
    }

    // -- portfolio -----------------------------------------------------------

    pub async fn check_portfolio(&self) -> crate::types::Portfolio {
        self.portfolio.lock().await.get_portfolio()
    }

    pub async fn get_trade_history(&self, limit: usize) -> Vec<Trade> {
        self.portfolio.lock().await.get_trade_history(limit)
    }

    // -- backtest ------------------------------------------------------------

    pub async fn run_backtest(
        &self,
        strategy: TradingStrategy,
        period_days: u32,
    ) -> BacktestResult {
        let num_candles = (period_days as usize) * 24; // hourly candles

        // Generate synthetic price series — RNG scoped to avoid Send issues
        let prices = {
            let mut rng = rand::thread_rng();
            let mut prices = Vec::with_capacity(num_candles);
            let mut price = 100.0_f64;
            for _ in 0..num_candles {
                price *= 1.0 + rng.gen_range(-0.02..0.02);
                price = price.max(1.0);
                prices.push(price);
            }
            prices
        };

        // Run strategy over windowed slices
        let strat: Box<dyn Strategy> = match strategy {
            TradingStrategy::Random => Box::new(RandomStrategy::new(0.3, 0.3)),
            TradingStrategy::RuleBased => Box::new(RuleBasedStrategy::default()),
            TradingStrategy::LlmDriven => Box::new(RandomStrategy::new(0.25, 0.25)),
        };

        let mut trades = Vec::new();
        let mut capital = 10_000.0_f64;
        let mut position = 0.0_f64;
        let mut peak = capital;
        let mut max_drawdown = 0.0_f64;

        let window = 25.min(prices.len());
        for i in window..prices.len() {
            let slice = &prices[i - window..=i];
            let md = MarketData {
                token: "BACKTEST".to_string(),
                current_price: prices[i],
                prices: slice.to_vec(),
                volume_24h: 1_000_000.0,
                change_24h_pct: if i > 0 {
                    (prices[i] - prices[i - 1]) / prices[i - 1] * 100.0
                } else {
                    0.0
                },
            };

            if let Some(signal) = strat.analyze(&md).await {
                let trade_amount = (capital * 0.1) / prices[i];
                let trade = Trade {
                    id: Uuid::new_v4().to_string(),
                    token: "BACKTEST".to_string(),
                    direction: signal.direction,
                    amount: trade_amount,
                    price: prices[i],
                    timestamp: Utc::now(),
                    strategy,
                    status: TradeStatus::Executed,
                };

                match signal.direction {
                    TradeDirection::Buy if capital >= trade_amount * prices[i] => {
                        capital -= trade_amount * prices[i];
                        position += trade_amount;
                        trades.push(trade);
                    }
                    TradeDirection::Sell if position >= trade_amount => {
                        capital += trade_amount * prices[i];
                        position -= trade_amount;
                        trades.push(trade);
                    }
                    _ => {}
                }
            }

            let total = capital + position * prices[i];
            if total > peak {
                peak = total;
            }
            let dd = (peak - total) / peak;
            if dd > max_drawdown {
                max_drawdown = dd;
            }
        }

        let final_value = capital + position * prices.last().copied().unwrap_or(100.0);
        let total_pnl = final_value - 10_000.0;
        let winning = trades
            .iter()
            .filter(|t| {
                t.direction == TradeDirection::Sell
                    && t.price > prices.first().copied().unwrap_or(100.0)
            })
            .count();
        let win_rate = if trades.is_empty() {
            0.0
        } else {
            winning as f64 / trades.len() as f64
        };

        let returns: Vec<f64> = prices
            .windows(2)
            .map(|w| (w[1] - w[0]) / w[0])
            .collect();
        let mean_return = returns.iter().sum::<f64>() / returns.len().max(1) as f64;
        let std_dev = (returns
            .iter()
            .map(|r| (r - mean_return).powi(2))
            .sum::<f64>()
            / returns.len().max(1) as f64)
            .sqrt();
        let sharpe = if std_dev > f64::EPSILON {
            mean_return / std_dev * (252.0_f64).sqrt()
        } else {
            0.0
        };

        BacktestResult {
            strategy,
            period_days,
            trades,
            total_pnl,
            win_rate,
            max_drawdown,
            sharpe_ratio: sharpe,
        }
    }

    /// Run backtests for each strategy and return them all.
    pub async fn compare_strategies(
        &self,
        strategies: &[TradingStrategy],
        period_days: u32,
    ) -> Vec<BacktestResult> {
        let mut results = Vec::new();
        for &s in strategies {
            results.push(self.run_backtest(s, period_days).await);
        }
        results
    }

    // -- performance ---------------------------------------------------------

    pub async fn analyze_performance(&self) -> PerformanceReport {
        let pm = self.portfolio.lock().await;
        let trades = pm.get_trade_history(0);
        let (pnl, pnl_pct) = pm.calculate_pnl();
        drop(pm);

        let mut winning = 0u64;
        let mut losing = 0u64;
        let mut win_sum = 0.0f64;
        let mut loss_sum = 0.0f64;

        for t in &trades {
            if t.status != TradeStatus::Executed {
                continue;
            }
            // Simplistic: buys at lower price count as wins on sell, etc.
            if t.direction == TradeDirection::Sell {
                let trade_pnl = t.amount * (t.price - 100.0); // vs baseline
                if trade_pnl > 0.0 {
                    winning += 1;
                    win_sum += trade_pnl;
                } else {
                    losing += 1;
                    loss_sum += trade_pnl.abs();
                }
            }
        }

        let total_trades = trades.len() as u64;
        let total_decided = winning + losing;
        let win_rate = if total_decided > 0 {
            winning as f64 / total_decided as f64
        } else {
            0.0
        };

        PerformanceReport {
            total_trades,
            winning_trades: winning,
            losing_trades: losing,
            total_pnl: pnl,
            total_pnl_pct: pnl_pct,
            win_rate,
            avg_win: if winning > 0 {
                win_sum / winning as f64
            } else {
                0.0
            },
            avg_loss: if losing > 0 {
                loss_sum / losing as f64
            } else {
                0.0
            },
            max_drawdown: 0.0,
            sharpe_ratio: 0.0,
        }
    }

    // -- market analysis -----------------------------------------------------

    pub async fn get_market_analysis(&self, token: &str) -> MarketAnalysis {
        let base = MockExchange::get_price(token);
        let mut rng = rand::thread_rng();

        let change: f64 = rng.gen_range(-5.0..5.0);
        let trend = if change > 1.5 {
            MarketTrend::Bullish
        } else if change < -1.5 {
            MarketTrend::Bearish
        } else {
            MarketTrend::Neutral
        };

        let recommendation = match trend {
            MarketTrend::Bullish => {
                if change > 3.0 {
                    Recommendation::StrongBuy
                } else {
                    Recommendation::Buy
                }
            }
            MarketTrend::Bearish => {
                if change < -3.0 {
                    Recommendation::StrongSell
                } else {
                    Recommendation::Sell
                }
            }
            MarketTrend::Neutral => Recommendation::Hold,
        };

        MarketAnalysis {
            token: token.to_string(),
            trend,
            support: base * 0.95,
            resistance: base * 1.05,
            volume_24h: rng.gen_range(100_000.0..10_000_000.0),
            recommendation,
        }
    }

    // -- strategy configuration ----------------------------------------------

    pub async fn configure_strategy(&self, config: StrategyConfig) -> Result<(), String> {
        if config.risk_level < 0.0 || config.risk_level > 1.0 {
            return Err("risk_level must be between 0.0 and 1.0".to_string());
        }
        if config.max_position_size <= 0.0 || config.max_position_size > 1.0 {
            return Err("max_position_size must be between 0.0 and 1.0".to_string());
        }
        if config.stop_loss_pct <= 0.0 {
            return Err("stop_loss_pct must be positive".to_string());
        }
        *self.strategy_config.lock().await = config;
        info!("Strategy reconfigured");
        Ok(())
    }

    pub async fn get_strategy_config(&self) -> StrategyConfig {
        self.strategy_config.lock().await.clone()
    }
}
