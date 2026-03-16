use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::TradingService;
use crate::{Action, ActionExample, ActionResult};

pub struct GetMarketAnalysisAction;

#[async_trait]
impl Action for GetMarketAnalysisAction {
    fn name(&self) -> &str {
        "GET_MARKET_ANALYSIS"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "MARKET_ANALYSIS",
            "ANALYZE_MARKET",
            "MARKET_REPORT",
            "CHECK_MARKET",
        ]
    }

    fn description(&self) -> &str {
        "Get market analysis for a specific token."
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

        let token = state
            .get("token")
            .and_then(|v| v.as_str())
            .unwrap_or("SOL");

        let analysis = svc.get_market_analysis(token).await;

        let text = format!(
            "Market Analysis for {}:\n  Trend: {}\n  Support: ${:.4}\n  Resistance: ${:.4}\n  Volume (24h): ${:.0}\n  Recommendation: {}",
            analysis.token,
            analysis.trend,
            analysis.support,
            analysis.resistance,
            analysis.volume_24h,
            analysis.recommendation,
        );

        ActionResult {
            success: true,
            text,
            data: Some(json!(analysis)),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "Analyze the SOL market".to_string(),
            agent_response: "Market Analysis for SOL: Trend: Bullish ...".to_string(),
        }]
    }
}
