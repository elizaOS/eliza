//! CAPABILITIES provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ModelType, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("CAPABILITIES"));

/// Provider for agent capabilities.
pub struct CapabilitiesProvider;

#[async_trait]
impl Provider for CapabilitiesProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(false)
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Check available models
        let model_types = [
            (ModelType::TextLarge, "TEXT_LARGE"),
            (ModelType::TextSmall, "TEXT_SMALL"),
            (ModelType::TextEmbedding, "TEXT_EMBEDDING"),
            (ModelType::Image, "IMAGE"),
            (ModelType::AudioTranscription, "AUDIO"),
        ];

        let available_models: Vec<&str> = model_types
            .iter()
            .filter(|(model_type, _)| runtime.has_model(*model_type))
            .map(|(_, name)| *name)
            .collect();

        // Check features based on settings
        let mut features: Vec<&str> = Vec::new();
        if runtime.get_setting("ENABLE_VOICE").is_some() {
            features.push("voice");
        }
        if runtime.get_setting("ENABLE_VISION").is_some() {
            features.push("vision");
        }
        if runtime.get_setting("ENABLE_MEMORY").is_some() {
            features.push("long_term_memory");
        }

        let mut text_parts: Vec<String> = vec!["# Agent Capabilities".to_string()];

        if !available_models.is_empty() {
            text_parts.push(format!("Models: {}", available_models.join(", ")));
        }

        if !features.is_empty() {
            text_parts.push(format!("Features: {}", features.join(", ")));
        }

        Ok(ProviderResult::new(text_parts.join("\n"))
            .with_value("modelCount", available_models.len() as i64)
            .with_value("hasVoice", features.contains(&"voice"))
            .with_value("hasVision", features.contains(&"vision"))
            .with_data(
                "models",
                serde_json::to_value(&available_models).unwrap_or_default(),
            )
            .with_data(
                "features",
                serde_json::to_value(&features).unwrap_or_default(),
            ))
    }
}
