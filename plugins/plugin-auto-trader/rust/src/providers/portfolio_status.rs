use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::TradingService;
use crate::{Provider, ProviderResult};

pub struct PortfolioStatusProvider;

#[async_trait]
impl Provider for PortfolioStatusProvider {
    fn name(&self) -> &str {
        "PORTFOLIO_STATUS"
    }

    fn description(&self) -> &str {
        "Provides current portfolio holdings, PnL, and trading state"
    }

    fn position(&self) -> i32 {
        50
    }

    async fn get(
        &self,
        _message: &Value,
        _state: &Value,
        service: Option<&TradingService>,
    ) -> ProviderResult {
        let Some(svc) = service else {
            return ProviderResult {
                values: json!({
                    "portfolioStatus": "Trading service is not available",
                    "tradingState": "unknown"
                }),
                text: "# Portfolio Status\n\nTrading service is not available.".to_string(),
                data: json!({ "holdings": 0, "state": "unknown" }),
            };
        };

        let portfolio = svc.check_portfolio().await;
        let state = svc.get_state().await;
        let config = svc.get_strategy_config().await;
        let history = svc.get_trade_history(5).await;

        let state_str = format!("{:?}", state);

        let mut text_parts = vec![
            format!("# Portfolio Status"),
            format!(""),
            format!("State: {}", state_str),
            format!("Strategy: {}", config.strategy),
            format!(
                "Total Value: ${:.2} | PnL: ${:.2} ({:+.2}%)",
                portfolio.total_value, portfolio.pnl, portfolio.pnl_pct
            ),
            format!(""),
            format!("## Holdings"),
        ];

        if portfolio.holdings.is_empty() {
            text_parts.push("No open positions.".to_string());
        } else {
            for (token, h) in &portfolio.holdings {
                text_parts.push(format!(
                    "- {}: {:.4} @ ${:.4} = ${:.2} (PnL: ${:.2})",
                    token, h.amount, h.current_price, h.value, h.pnl
                ));
            }
        }

        if !history.is_empty() {
            text_parts.push(String::new());
            text_parts.push("## Recent Trades".to_string());
            for t in &history {
                text_parts.push(format!(
                    "- {} {} {:.4} {} @ ${:.4}",
                    t.timestamp.format("%H:%M:%S"),
                    t.direction,
                    t.amount,
                    t.token,
                    t.price
                ));
            }
        }

        ProviderResult {
            values: json!({
                "portfolioStatus": format!(
                    "${:.2} | PnL: ${:.2} ({:+.2}%)",
                    portfolio.total_value, portfolio.pnl, portfolio.pnl_pct
                ),
                "tradingState": state_str,
                "strategy": config.strategy.to_string(),
            }),
            text: text_parts.join("\n"),
            data: json!({
                "holdings": portfolio.holdings.len(),
                "totalValue": portfolio.total_value,
                "pnl": portfolio.pnl,
                "state": state_str,
                "recentTrades": history.len(),
            }),
        }
    }
}
