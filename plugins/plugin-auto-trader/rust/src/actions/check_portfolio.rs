use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::TradingService;
use crate::{Action, ActionExample, ActionResult};

pub struct CheckPortfolioAction;

#[async_trait]
impl Action for CheckPortfolioAction {
    fn name(&self) -> &str {
        "CHECK_PORTFOLIO"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "VIEW_PORTFOLIO",
            "SHOW_PORTFOLIO",
            "GET_PORTFOLIO",
            "PORTFOLIO_STATUS",
        ]
    }

    fn description(&self) -> &str {
        "Check the current portfolio holdings and PnL."
    }

    async fn validate(&self, _message: &Value, _state: &Value) -> bool {
        true
    }

    async fn handler(
        &self,
        _message: &Value,
        _state: &Value,
        service: Option<&TradingService>,
    ) -> ActionResult {
        let Some(svc) = service else {
            return ActionResult {
                success: false,
                text: "TradingService is not available.".to_string(),
                data: None,
                error: Some("missing_service".to_string()),
            };
        };

        let portfolio = svc.check_portfolio().await;

        let mut lines = vec![format!(
            "Portfolio: ${:.2} | PnL: ${:.2} ({:+.2}%)",
            portfolio.total_value, portfolio.pnl, portfolio.pnl_pct
        )];

        for (token, h) in &portfolio.holdings {
            lines.push(format!(
                "  {}: {:.4} @ ${:.4} = ${:.2} (PnL: ${:.2})",
                token, h.amount, h.current_price, h.value, h.pnl
            ));
        }

        if portfolio.holdings.is_empty() {
            lines.push("  No open positions.".to_string());
        }

        ActionResult {
            success: true,
            text: lines.join("\n"),
            data: Some(json!(portfolio)),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "Check my portfolio".to_string(),
            agent_response: "Portfolio: $10,000.00 | PnL: $0.00 (+0.00%)".to_string(),
        }]
    }
}
