//! CHOICE provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("CHOICE"));

/// Provider for choice options.
pub struct ChoiceProvider;

#[async_trait]
impl Provider for ChoiceProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(true)
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Extract choices from message metadata
        let choices: Vec<serde_json::Value> = message
            .metadata
            .get("choices")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        // Also check state for choices
        let state_choices: Vec<serde_json::Value> = state
            .and_then(|s| s.get_value("choices"))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();

        let all_choices: Vec<serde_json::Value> =
            choices.into_iter().chain(state_choices).collect();

        if all_choices.is_empty() {
            return Ok(ProviderResult::new("")
                .with_value("hasChoices", false)
                .with_value("choiceCount", 0i64));
        }

        let formatted: Vec<String> = all_choices
            .iter()
            .enumerate()
            .map(|(i, choice)| {
                let label = choice
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Option");
                let value = choice
                    .get("value")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| i.to_string());
                format!("{}. [{}] {}", i + 1, value, label)
            })
            .collect();

        let text = format!("# Available Choices\n{}", formatted.join("\n"));

        let labels: Vec<String> = all_choices
            .iter()
            .map(|c| {
                c.get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();

        Ok(ProviderResult::new(text)
            .with_value("hasChoices", true)
            .with_value("choiceCount", all_choices.len() as i64)
            .with_data(
                "choiceLabels",
                serde_json::to_value(&labels).unwrap_or_default(),
            )
            .with_data(
                "choices",
                serde_json::to_value(&all_choices).unwrap_or_default(),
            ))
    }
}
