use async_trait::async_trait;
use serde_json::Value;

use crate::service::TradingService;
use crate::types::{StrategyConfig, TradingStrategy};
use crate::{Action, ActionExample, ActionResult};

pub struct ConfigureStrategyAction;

fn parse_strategy(val: &str) -> TradingStrategy {
    match val.to_lowercase().as_str() {
        "rule_based" | "rulebased" | "rule-based" | "technical" => TradingStrategy::RuleBased,
        "llm" | "llm_driven" | "ai" => TradingStrategy::LlmDriven,
        _ => TradingStrategy::Random,
    }
}

#[async_trait]
impl Action for ConfigureStrategyAction {
    fn name(&self) -> &str {
        "CONFIGURE_STRATEGY"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SET_STRATEGY",
            "UPDATE_STRATEGY",
            "CHANGE_STRATEGY",
            "STRATEGY_CONFIG",
        ]
    }

    fn description(&self) -> &str {
        "Configure or update the trading strategy parameters."
    }

    async fn validate(&self, _message: &Value, _state: &Value) -> bool {
        true
    }

    async fn handler(
        &self,
        _message: &Value,
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

        let current = svc.get_strategy_config().await;

        let strategy = state
            .get("strategy")
            .and_then(|v| v.as_str())
            .map(parse_strategy)
            .unwrap_or(current.strategy);

        let config = StrategyConfig {
            strategy,
            risk_level: state
                .get("risk_level")
                .and_then(|v| v.as_f64())
                .unwrap_or(current.risk_level),
            max_position_size: state
                .get("max_position_size")
                .and_then(|v| v.as_f64())
                .unwrap_or(current.max_position_size),
            stop_loss_pct: state
                .get("stop_loss_pct")
                .and_then(|v| v.as_f64())
                .unwrap_or(current.stop_loss_pct),
            take_profit_pct: state
                .get("take_profit_pct")
                .and_then(|v| v.as_f64())
                .unwrap_or(current.take_profit_pct),
            max_daily_trades: state
                .get("max_daily_trades")
                .and_then(|v| v.as_u64())
                .unwrap_or(current.max_daily_trades as u64) as u32,
        };

        match svc.configure_strategy(config.clone()).await {
            Ok(()) => ActionResult {
                success: true,
                text: format!(
                    "Strategy configured: {} (risk={:.2}, max_pos={:.0}%, SL={:.1}%, TP={:.1}%, max_trades={})",
                    config.strategy,
                    config.risk_level,
                    config.max_position_size * 100.0,
                    config.stop_loss_pct,
                    config.take_profit_pct,
                    config.max_daily_trades,
                ),
                data: None,
                error: None,
            },
            Err(e) => ActionResult {
                success: false,
                text: e,
                data: None,
                error: Some("configure_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "Set the strategy to rule-based with 3% stop loss".to_string(),
            agent_response: "Strategy configured: RuleBased (risk=0.50, ...)".to_string(),
        }]
    }
}
