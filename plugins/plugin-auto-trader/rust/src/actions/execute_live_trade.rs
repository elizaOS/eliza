use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::TradingService;
use crate::types::TradeDirection;
use crate::{Action, ActionExample, ActionResult};

pub struct ExecuteLiveTradeAction;

#[async_trait]
impl Action for ExecuteLiveTradeAction {
    fn name(&self) -> &str {
        "EXECUTE_LIVE_TRADE"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "EXECUTE_TRADE",
            "PLACE_TRADE",
            "MAKE_TRADE",
            "BUY_TOKEN",
            "SELL_TOKEN",
        ]
    }

    fn description(&self) -> &str {
        "Execute a live trade (buy/sell) on the mock exchange."
    }

    async fn validate(&self, _message: &Value, _state: &Value) -> bool {
        true
    }

    async fn handler(
        &self,
        message: &Value,
        state: &Value,
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

        let token = state
            .get("token")
            .and_then(|v| v.as_str())
            .unwrap_or("SOL");

        let amount = state
            .get("amount")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0);

        let text = message
            .pointer("/content/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let direction_str = state
            .get("direction")
            .and_then(|v| v.as_str())
            .unwrap_or(text);

        let direction = if direction_str.to_lowercase().contains("sell") {
            TradeDirection::Sell
        } else {
            TradeDirection::Buy
        };

        match svc.execute_trade(token, direction, amount).await {
            Ok(trade) => {
                let text = format!(
                    "Trade executed: {} {:.4} {} @ ${:.4} (ID: {})",
                    trade.direction, trade.amount, trade.token, trade.price, trade.id
                );
                ActionResult {
                    success: true,
                    text,
                    data: Some(json!(trade)),
                    error: None,
                }
            }
            Err(e) => ActionResult {
                success: false,
                text: e,
                data: None,
                error: Some("trade_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "Buy 10 SOL".to_string(),
                agent_response: "Trade executed: BUY 10.0000 SOL @ $150.00".to_string(),
            },
            ActionExample {
                user_message: "Sell 5 ETH".to_string(),
                agent_response: "Trade executed: SELL 5.0000 ETH @ $2500.00".to_string(),
            },
        ]
    }
}
