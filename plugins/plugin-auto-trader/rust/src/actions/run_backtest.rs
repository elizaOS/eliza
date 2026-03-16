use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::TradingService;
use crate::types::TradingStrategy;
use crate::{Action, ActionExample, ActionResult};

pub struct RunBacktestAction;

fn parse_strategy(val: &str) -> TradingStrategy {
    match val.to_lowercase().as_str() {
        "rule_based" | "rulebased" | "rule-based" | "technical" => TradingStrategy::RuleBased,
        "llm" | "llm_driven" | "ai" => TradingStrategy::LlmDriven,
        _ => TradingStrategy::Random,
    }
}

#[async_trait]
impl Action for RunBacktestAction {
    fn name(&self) -> &str {
        "RUN_BACKTEST"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["BACKTEST", "SIMULATE_STRATEGY", "TEST_STRATEGY"]
    }

    fn description(&self) -> &str {
        "Run a backtest for a given strategy over a specified period."
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

        let strategy = state
            .get("strategy")
            .and_then(|v| v.as_str())
            .map(parse_strategy)
            .unwrap_or(TradingStrategy::Random);

        let period = state
            .get("period_days")
            .and_then(|v| v.as_u64())
            .unwrap_or(30) as u32;

        let result = svc.run_backtest(strategy, period).await;

        let text = format!(
            "Backtest Results ({}, {} days):\n  Trades: {}\n  Total PnL: ${:.2}\n  Win Rate: {:.1}%\n  Max Drawdown: {:.2}%\n  Sharpe Ratio: {:.2}",
            strategy,
            period,
            result.trades.len(),
            result.total_pnl,
            result.win_rate * 100.0,
            result.max_drawdown * 100.0,
            result.sharpe_ratio,
        );

        ActionResult {
            success: true,
            text,
            data: Some(json!(result)),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "Backtest the random strategy over 30 days".to_string(),
            agent_response: "Backtest Results (Random, 30 days): ...".to_string(),
        }]
    }
}
