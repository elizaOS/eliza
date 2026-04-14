//! REFLECTION evaluator implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::{PluginError, PluginResult};
use crate::generated::spec_helpers::require_evaluator_spec;
use crate::prompts::REFLECTION_TEMPLATE;
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{EvaluatorResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Evaluator;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::EvaluatorDoc> =
    Lazy::new(|| require_evaluator_spec("REFLECTION"));

/// Evaluator for reflection on behavior.
pub struct ReflectionEvaluator;

#[async_trait]
impl Evaluator for ReflectionEvaluator {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn evaluate(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let room_id = match message.room_id {
            Some(id) => id,
            None => {
                return Ok(EvaluatorResult::pass(50, "No room for reflection")
                    .with_detail("noInteractions", true));
            }
        };

        // Get recent messages for reflection
        let recent_messages = runtime
            .get_memories(Some(room_id), None, None, 10)
            .await
            .unwrap_or_default();

        if recent_messages.is_empty() {
            return Ok(
                EvaluatorResult::pass(50, "No recent interactions to reflect on")
                    .with_detail("noInteractions", true),
            );
        }

        // Format interactions
        let mut interactions = Vec::new();
        for msg in recent_messages.iter().rev() {
            if msg.content.text.is_empty() {
                continue;
            }

            let sender = if let Some(entity_id) = msg.entity_id {
                if entity_id == runtime.agent_id() {
                    runtime.character().name.clone()
                } else if let Ok(Some(entity)) = runtime.get_entity(entity_id).await {
                    entity.name.unwrap_or_else(|| "Unknown".to_string())
                } else {
                    "Unknown".to_string()
                }
            } else {
                "Unknown".to_string()
            };

            interactions.push(format!("{}: {}", sender, msg.content.text));
        }

        let interactions_text = interactions.join("\n");

        // Get template and compose prompt
        let template = runtime
            .character()
            .templates
            .get("reflectionTemplate")
            .map(|s| s.as_str())
            .unwrap_or(REFLECTION_TEMPLATE);

        let composed_state = runtime.compose_state(message, &["RECENT_MESSAGES"]).await?;

        let prompt = runtime
            .compose_prompt(&composed_state, template)
            .replace("{{recentInteractions}}", &interactions_text);

        // Call the model
        let response = runtime
            .use_model(ModelType::TextLarge, ModelParams::with_prompt(&prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let response_text = response
            .as_text()
            .ok_or_else(|| PluginError::ModelError("Expected text response".to_string()))?;

        // Parse XML response
        let parsed = parse_key_value_xml(response_text).ok_or_else(|| {
            PluginError::XmlParse("Failed to parse reflection response".to_string())
        })?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let quality_str = parsed
            .get("quality_score")
            .cloned()
            .unwrap_or_else(|| "50".to_string());
        let strengths = parsed.get("strengths").cloned().unwrap_or_default();
        let improvements = parsed.get("improvements").cloned().unwrap_or_default();
        let learnings = parsed.get("learnings").cloned().unwrap_or_default();

        let quality_score: u8 = quality_str.parse().unwrap_or(50).min(100);

        let passed = quality_score >= 50;
        let reason = format!("Strengths: {}\nImprovements: {}", strengths, improvements);

        let result = if passed {
            EvaluatorResult::pass(quality_score, &reason)
        } else {
            EvaluatorResult::fail(quality_score, &reason)
        };

        Ok(result
            .with_detail("thought", thought)
            .with_detail("strengths", strengths)
            .with_detail("improvements", improvements)
            .with_detail("learnings", learnings)
            .with_detail("interactionCount", interactions.len() as i64))
    }
}
