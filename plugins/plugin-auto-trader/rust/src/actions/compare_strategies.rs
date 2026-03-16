use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::TradingService;
use crate::types::TradingStrategy;
use crate::{Action, ActionExample, ActionResult};

pub struct CompareStrategiesAction;

#[async_trait]
impl Action for CompareStrategiesAction {
    fn name(&self) -> &str {
        "COMPARE_STRATEGIES"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["COMPARE_BACKTEST", "STRATEGY_COMPARISON", "RANK_STRATEGIES"]
    }

    fn description(&self) -> &str {
        "Compare multiple trading strategies via backtesting."
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

        let period = state
            .get("period_days")
            .and_then(|v| v.as_u64())
            .unwrap_or(30) as u32;

        let strategies = vec![
            TradingStrategy::Random,
            TradingStrategy::RuleBased,
            TradingStrategy::LlmDriven,
        ];

        let results = svc.compare_strategies(&strategies, period).await;

        let mut lines = vec![format!("Strategy Comparison ({} days):", period)];
        for r in &results {
            lines.push(format!(
                "  {}: PnL=${:.2}, WinRate={:.1}%, Drawdown={:.2}%, Sharpe={:.2}",
                r.strategy,
                r.total_pnl,
                r.win_rate * 100.0,
                r.max_drawdown * 100.0,
                r.sharpe_ratio,
            ));
        }

        ActionResult {
            success: true,
            text: lines.join("\n"),
            data: Some(json!(results)),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "Compare all strategies over 30 days".to_string(),
            agent_response: "Strategy Comparison (30 days): ...".to_string(),
        }]
    }
}
