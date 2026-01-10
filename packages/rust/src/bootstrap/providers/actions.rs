//! ACTIONS provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for available actions.
pub struct ActionsProvider;

#[async_trait]
impl Provider for ActionsProvider {
    fn name(&self) -> &'static str {
        "ACTIONS"
    }

    fn description(&self) -> &'static str {
        "Possible response actions"
    }

    fn is_dynamic(&self) -> bool {
        false
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let actions = runtime.get_available_actions();

        if actions.is_empty() {
            return Ok(ProviderResult::new("No actions available."));
        }

        let action_names: Vec<&str> = actions.iter().map(|a| a.name.as_str()).collect();
        let names_text = action_names.join(", ");

        let formatted_actions: Vec<String> = actions
            .iter()
            .map(|a| format!("- {}: {}", a.name, a.description))
            .collect();

        let text = format!(
            "Possible response actions: {}\n\n# Available Actions\n{}",
            names_text,
            formatted_actions.join("\n")
        );

        Ok(ProviderResult::new(text)
            .with_value("actionNames", names_text)
            .with_value("actionCount", actions.len() as i64)
            .with_data("actions", serde_json::to_value(&actions).unwrap_or_default()))
    }
}


