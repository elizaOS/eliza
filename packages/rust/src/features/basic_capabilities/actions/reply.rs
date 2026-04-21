//! REPLY action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;

use crate::error::{PluginError, PluginResult};
use crate::generated::spec_helpers::require_action_spec;
use crate::prompts::REPLY_TEMPLATE;
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("REPLY"));

/// Action for generating and sending a reply message.
pub struct ReplyAction;

#[async_trait]
impl Action for ReplyAction {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn similes(&self) -> &[&'static str] {
        // Convert Vec<String> to static slice - this is safe because SPEC is Lazy/static
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
        responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for reply action".to_string())
        })?;

        // Gather providers from previous responses
        let mut all_providers: Vec<&str> = vec!["RECENT_MESSAGES", "ACTION_STATE"];
        if let Some(resps) = responses {
            for resp in resps {
                for provider in &resp.content.providers {
                    if !all_providers.contains(&provider.as_str()) {
                        all_providers.push(Box::leak(provider.clone().into_boxed_str()));
                    }
                }
            }
        }

        // Compose state with providers
        let composed_state = runtime.compose_state(message, &all_providers).await?;

        // Get template
        let template = runtime
            .character()
            .templates
            .get("replyTemplate")
            .map(|s| s.as_str())
            .unwrap_or(REPLY_TEMPLATE);

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
        let text = parsed.get("text").cloned().unwrap_or_default();

        Ok(ActionResult::success(format!("Generated reply: {}", text))
            .with_value("success", true)
            .with_value("responded", true)
            .with_value("lastReply", text.clone())
            .with_value("lastReplyTime", runtime.get_current_timestamp())
            .with_value("thoughtProcess", thought.clone())
            .with_data("actionName", "REPLY")
            .with_data("responseThought", thought.clone())
            .with_data("responseText", text.clone())
            .with_data("thought", thought)
            .with_data("messageGenerated", true))
    }
}
