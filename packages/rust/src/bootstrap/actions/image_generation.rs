//! GENERATE_IMAGE action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;

use crate::bootstrap::runtime::{IAgentRuntime, ModelOutput, ModelParams};
use crate::error::{PluginError, PluginResult};
use crate::generated::spec_helpers::require_action_spec;
use crate::prompts::IMAGE_GENERATION_TEMPLATE;
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("GENERATE_IMAGE"));

/// Action for generating images.
pub struct GenerateImageAction;

#[async_trait]
impl Action for GenerateImageAction {
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

    async fn validate(&self, runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        runtime.has_model(ModelType::Image)
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let _state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for GENERATE_IMAGE action".to_string())
        })?;

        // Compose state
        let composed_state = runtime
            .compose_state(message, &["RECENT_MESSAGES", "ACTION_STATE"])
            .await?;

        // Get template
        let template = runtime
            .character()
            .templates
            .get("imageGenerationTemplate")
            .map(|s| s.as_str())
            .unwrap_or(IMAGE_GENERATION_TEMPLATE);

        let prompt = runtime.compose_prompt(&composed_state, template);

        // First, generate the image prompt using text model
        let prompt_response = runtime
            .use_model(ModelType::TextLarge, ModelParams::with_prompt(&prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let prompt_text = prompt_response
            .as_text()
            .ok_or_else(|| PluginError::ModelError("Expected text response".to_string()))?;

        // Parse XML response
        let parsed = parse_key_value_xml(prompt_text)
            .ok_or_else(|| PluginError::XmlParse("Failed to parse prompt response".to_string()))?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let image_prompt = parsed
            .get("prompt")
            .cloned()
            .ok_or_else(|| PluginError::InvalidInput("No image prompt generated".to_string()))?;

        // Generate the image
        let image_response = runtime
            .use_model(ModelType::Image, ModelParams::with_prompt(&image_prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let image_url = match image_response {
            ModelOutput::ImageUrl(url) => url,
            ModelOutput::Structured(v) => v
                .get("url")
                .or_else(|| v.get("data"))
                .and_then(|u| u.as_str())
                .map(String::from)
                .ok_or_else(|| PluginError::ModelError("No image URL in response".to_string()))?,
            _ => {
                return Err(PluginError::ModelError(
                    "Unexpected response type from image model".to_string(),
                ))
            }
        };

        Ok(
            ActionResult::success(format!("Generated image: {}", image_prompt))
                .with_value("success", true)
                .with_value("imageGenerated", true)
                .with_value("imageUrl", image_url.clone())
                .with_value("imagePrompt", image_prompt.clone())
                .with_data("actionName", "GENERATE_IMAGE")
                .with_data("prompt", image_prompt)
                .with_data("thought", thought)
                .with_data("imageUrl", image_url),
        )
    }
}
