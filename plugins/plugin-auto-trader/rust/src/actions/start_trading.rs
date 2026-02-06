use async_trait::async_trait;
use serde_json::Value;

use crate::service::TradingService;
use crate::types::{StrategyConfig, TradingStrategy};
use crate::{Action, ActionExample, ActionResult};

pub struct StartTradingAction;

fn parse_strategy(text: &str) -> TradingStrategy {
    let lower = text.to_lowercase();
    if lower.contains("rule") || lower.contains("technical") {
        TradingStrategy::RuleBased
    } else if lower.contains("llm") || lower.contains("ai") || lower.contains("smart") {
        TradingStrategy::LlmDriven
    } else {
        TradingStrategy::Random
    }
}

#[async_trait]
impl Action for StartTradingAction {
    fn name(&self) -> &str {
        "START_TRADING"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "BEGIN_TRADING",
            "START_AUTO_TRADING",
            "ENABLE_TRADING",
            "TURN_ON_TRADING",
        ]
    }

    fn description(&self) -> &str {
        "Start automated trading with a specified strategy."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .pointer("/content/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let lower = text.to_lowercase();
        lower.contains("start") || lower.contains("begin") || lower.contains("enable")
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

        let text = message
            .pointer("/content/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let strategy = state
            .get("strategy")
            .and_then(|v| v.as_str())
            .map(parse_strategy)
            .unwrap_or_else(|| parse_strategy(text));

        let risk = state
            .get("risk_level")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.5);

        let config = StrategyConfig {
            strategy,
            risk_level: risk,
            ..StrategyConfig::default()
        };

        match svc.start_trading(config).await {
            Ok(()) => ActionResult {
                success: true,
                text: format!("Auto-trading started with {} strategy.", strategy),
                data: None,
                error: None,
            },
            Err(e) => ActionResult {
                success: false,
                text: e,
                data: None,
                error: Some("start_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "Start trading with the random strategy".to_string(),
                agent_response: "Auto-trading started with Random strategy.".to_string(),
            },
            ActionExample {
                user_message: "Begin AI trading".to_string(),
                agent_response: "Auto-trading started with LLMDriven strategy.".to_string(),
            },
        ]
    }
}
