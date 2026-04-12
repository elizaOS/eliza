//! THINK action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;

use crate::basic_capabilities::runtime::{IAgentRuntime, ModelParams};
use crate::error::{PluginError, PluginResult};
use crate::generated::spec_helpers::require_action_spec;
use crate::prompts::THINK_TEMPLATE;
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("THINK"));

/// Action for deep thinking and careful reasoning.
/// Re-processes the full conversation context through a larger model when
/// the initial planning pass determines the question needs deeper analysis.
pub struct ThinkAction;

#[async_trait]
impl Action for ThinkAction {
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
        let _state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for THINK action".to_string())
        })?;

        // Compose full state with all available context
        let composed_state = runtime
            .compose_state(message, &["RECENT_MESSAGES", "ACTION_STATE"])
            .await?;

        let template = runtime
            .character()
            .templates
            .get("thinkTemplate")
            .map(|s| s.as_str())
            .unwrap_or(THINK_TEMPLATE);

        let prompt = runtime.compose_prompt(&composed_state, template);

        // Use the large model for deeper reasoning — this is the core
        // upgrade over the default planning pass which uses ACTION_PLANNER
        let response = runtime
            .use_model(ModelType::TextLarge, ModelParams::with_prompt(&prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let response_text = response
            .as_text()
            .ok_or_else(|| PluginError::ModelError("Expected text response".to_string()))?;

        let parsed = parse_key_value_xml(response_text)
            .ok_or_else(|| PluginError::XmlParse("Failed to parse think response".to_string()))?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let text = parsed.get("text").cloned().unwrap_or_default();

        // The result flows to subsequent actions via previousResults.
        // Downstream actions see this as the first link in the chain.
        Ok(
            ActionResult::success(text.clone())
                .with_value("success", true)
                .with_value("responded", true)
                .with_value("lastReply", text.clone())
                .with_value("thoughtProcess", thought.clone())
                .with_data("actionName", "THINK")
                .with_data("responseThought", thought.clone())
                .with_data("responseText", text)
                .with_data("thought", thought)
                .with_data("messageGenerated", true),
        )
    }
}
