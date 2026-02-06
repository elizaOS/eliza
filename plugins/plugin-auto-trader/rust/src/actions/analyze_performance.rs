use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::TradingService;
use crate::{Action, ActionExample, ActionResult};

pub struct AnalyzePerformanceAction;

#[async_trait]
impl Action for AnalyzePerformanceAction {
    fn name(&self) -> &str {
        "ANALYZE_PERFORMANCE"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "PERFORMANCE_REPORT",
            "TRADING_STATS",
            "SHOW_PERFORMANCE",
            "GET_STATS",
        ]
    }

    fn description(&self) -> &str {
        "Analyze trading performance and return a detailed report."
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

        let report = svc.analyze_performance().await;

        let text = format!(
            "Performance Report:\n  Total Trades: {}\n  Winning: {} | Losing: {}\n  Win Rate: {:.1}%\n  Total PnL: ${:.2} ({:+.2}%)\n  Avg Win: ${:.2} | Avg Loss: ${:.2}\n  Max Drawdown: {:.2}%\n  Sharpe Ratio: {:.2}",
            report.total_trades,
            report.winning_trades,
            report.losing_trades,
            report.win_rate * 100.0,
            report.total_pnl,
            report.total_pnl_pct,
            report.avg_win,
            report.avg_loss,
            report.max_drawdown * 100.0,
            report.sharpe_ratio,
        );

        ActionResult {
            success: true,
            text,
            data: Some(json!(report)),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "Show my trading performance".to_string(),
            agent_response: "Performance Report: ...".to_string(),
        }]
    }
}
