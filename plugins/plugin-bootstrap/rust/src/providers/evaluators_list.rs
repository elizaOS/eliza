//! EVALUATORS provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for available evaluators.
pub struct EvaluatorsProvider;

#[async_trait]
impl Provider for EvaluatorsProvider {
    fn name(&self) -> &'static str {
        "EVALUATORS"
    }

    fn description(&self) -> &'static str {
        "Available evaluators for assessing agent behavior"
    }

    fn is_dynamic(&self) -> bool {
        false
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Get evaluators from the bootstrap plugin itself
        let evaluators = crate::evaluators::all_evaluators();

        if evaluators.is_empty() {
            return Ok(ProviderResult::new("No evaluators available.")
                .with_value("evaluatorCount", 0i64));
        }

        let evaluator_info: Vec<serde_json::Value> = evaluators
            .iter()
            .map(|e| {
                serde_json::json!({
                    "name": e.name(),
                    "description": e.description()
                })
            })
            .collect();

        let formatted: Vec<String> = evaluators
            .iter()
            .map(|e| format!("- {}: {}", e.name(), e.description()))
            .collect();

        let text = format!("# Available Evaluators\n{}", formatted.join("\n"));

        let names: Vec<&str> = evaluators.iter().map(|e| e.name()).collect();

        Ok(ProviderResult::new(text)
            .with_value("evaluatorCount", evaluators.len() as i64)
            .with_data("evaluatorNames", serde_json::to_value(&names).unwrap_or_default())
            .with_data("evaluators", serde_json::to_value(&evaluator_info).unwrap_or_default()))
    }
}


