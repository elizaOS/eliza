//! ACTION_STATE provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for action state information.
pub struct ActionStateProvider;

#[async_trait]
impl Provider for ActionStateProvider {
    fn name(&self) -> &'static str {
        "ACTION_STATE"
    }

    fn description(&self) -> &'static str {
        "Provides information about the current action state and available actions"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let mut sections = Vec::new();

        // Get available actions
        let available_actions = runtime.get_available_actions();
        let action_names: Vec<String> = available_actions.iter().map(|a| a.name.clone()).collect();

        if !action_names.is_empty() {
            sections.push("## Available Actions".to_string());
            sections.push(action_names.join(", "));
        }

        // Get action state from state if available
        let mut pending: Vec<String> = Vec::new();
        let mut completed: Vec<String> = Vec::new();

        if let Some(state) = state {
            if let Some(pending_val) = state.values.get("pendingActions") {
                if let Some(arr) = pending_val.as_array() {
                    pending = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                }
            }

            if let Some(completed_val) = state.values.get("completedActions") {
                if let Some(arr) = completed_val.as_array() {
                    completed = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                }
            }
        }

        if !pending.is_empty() {
            sections.push("\n## Pending Actions".to_string());
            sections.push(
                pending
                    .iter()
                    .map(|a| format!("- {}", a))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }

        if !completed.is_empty() {
            sections.push("\n## Recently Completed".to_string());
            let recent: Vec<_> = completed.iter().rev().take(5).collect();
            sections.push(
                recent
                    .iter()
                    .map(|a| format!("- {}", a))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }

        let context_text = if sections.is_empty() {
            String::new()
        } else {
            format!("# Action State\n{}", sections.join("\n"))
        };

        Ok(ProviderResult::new(context_text)
            .with_value("availableActionCount", action_names.len() as i64)
            .with_value("pendingActionCount", pending.len() as i64)
            .with_value("completedActionCount", completed.len() as i64)
            .with_data("available", action_names)
            .with_data("pending", pending)
            .with_data("completed", completed))
    }
}
