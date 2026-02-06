use async_trait::async_trait;
use serde_json::Value;

use crate::service::TradingService;
use crate::{Action, ActionExample, ActionResult};

pub struct StopTradingAction;

#[async_trait]
impl Action for StopTradingAction {
    fn name(&self) -> &str {
        "STOP_TRADING"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "END_TRADING",
            "STOP_AUTO_TRADING",
            "DISABLE_TRADING",
            "TURN_OFF_TRADING",
        ]
    }

    fn description(&self) -> &str {
        "Stop automated trading."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .pointer("/content/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let lower = text.to_lowercase();
        lower.contains("stop") || lower.contains("end") || lower.contains("disable")
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

        match svc.stop_trading().await {
            Ok(()) => ActionResult {
                success: true,
                text: "Auto-trading stopped.".to_string(),
                data: None,
                error: None,
            },
            Err(e) => ActionResult {
                success: false,
                text: e,
                data: None,
                error: Some("stop_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "Stop trading".to_string(),
            agent_response: "Auto-trading stopped.".to_string(),
        }]
    }
}
