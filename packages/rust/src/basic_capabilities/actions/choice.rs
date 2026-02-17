//! CHOOSE_OPTION action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;

use crate::error::{PluginError, PluginResult};
use crate::generated::spec_helpers::require_action_spec;
use crate::prompts::CHOOSE_OPTION_TEMPLATE;
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("CHOOSE_OPTION"));

/// Action for choosing from available options.
pub struct ChooseOptionAction;

#[async_trait]
impl Action for ChooseOptionAction {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn similes(&self) -> &[&'static str] {
        static SIMILES: Lazy<Box<[&'static str]>> = Lazy::new(|| {
            SPEC.similes
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .into_boxed_slice()
        });
        &SIMILES
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for CHOOSE_OPTION action".to_string())
        })?;

        // Compose state
        let composed_state = runtime
            .compose_state(message, &["RECENT_MESSAGES", "ACTION_STATE"])
            .await?;

        // Get template
        let template = runtime
            .character()
            .templates
            .get("chooseOptionTemplate")
            .map(|s| s.as_str())
            .unwrap_or(CHOOSE_OPTION_TEMPLATE);

        let prompt = runtime.compose_prompt(&composed_state, template);

        // Call the model
        let response = runtime
            .use_model(ModelType::TextLarge, ModelParams::with_prompt(&prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let response_text = response
            .as_text()
            .ok_or_else(|| PluginError::ModelError("Expected text response".to_string()))?;

        // Parse XML response
        let parsed = parse_key_value_xml(response_text)
            .ok_or_else(|| PluginError::XmlParse("Failed to parse response XML".to_string()))?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let selected_id = parsed.get("selected_id").cloned().unwrap_or_default();

        if selected_id.is_empty() {
            return Err(PluginError::InvalidInput("No option selected".to_string()));
        }

        Ok(
            ActionResult::success(format!("Selected option: {}", selected_id))
                .with_value("success", true)
                .with_value("selectedId", selected_id.clone())
                .with_value("thought", thought.clone())
                .with_data("actionName", "CHOOSE_OPTION")
                .with_data("selectedId", selected_id)
                .with_data("thought", thought),
        )
    }
}
