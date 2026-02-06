use async_trait::async_trait;
use serde_json::Value;

use crate::registry::CommandRegistry;
use crate::{Action, ActionExample, ActionResult};

/// Known model type descriptions for user-friendly output.
fn describe_model_type(model_type: &str) -> &str {
    match model_type {
        "text_small" => "Text (Small)",
        "text_large" => "Text (Large)",
        "text_reasoning_small" => "Reasoning (Small)",
        "text_reasoning_large" => "Reasoning (Large)",
        "text_completion" => "Text Completion",
        "text_embedding" => "Embedding",
        "image" => "Image Generation",
        "image_description" => "Image Description",
        "transcription" => "Transcription",
        "text_to_speech" => "Text-to-Speech",
        "audio" => "Audio",
        "video" => "Video",
        "object_small" => "Object (Small)",
        "object_large" => "Object (Large)",
        "research" => "Research",
        other => other,
    }
}

pub struct ModelsCommandAction;

#[async_trait]
impl Action for ModelsCommandAction {
    fn name(&self) -> &str {
        "MODELS_COMMAND"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["/models"]
    }

    fn description(&self) -> &str {
        "List available AI models and providers. Only activates for /models slash command."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if let Some(parsed) = crate::parser::parse_command(text) {
            parsed.name == "models"
        } else {
            false
        }
    }

    async fn handler(
        &self,
        message: &Value,
        state: &Value,
        _registry: Option<&CommandRegistry>,
    ) -> ActionResult {
        let mut lines = vec!["**Available Models:**".to_string(), String::new()];

        // Check if models are provided in state
        let model_types = state
            .get("registered_model_types")
            .and_then(|v| v.as_array());

        if let Some(types) = model_types {
            lines.push("**Registered Model Types:**".to_string());
            for mt in types {
                if let Some(s) = mt.as_str() {
                    lines.push(format!(
                        "  {} (`{}`)",
                        describe_model_type(s),
                        s
                    ));
                }
            }
        } else {
            lines.push("No model information available.".to_string());
        }

        // Show current configuration if available
        let provider = message
            .get("model_provider")
            .and_then(|v| v.as_str())
            .or_else(|| state.get("model_provider").and_then(|v| v.as_str()));
        let model_name = message
            .get("model_name")
            .and_then(|v| v.as_str())
            .or_else(|| state.get("model_name").and_then(|v| v.as_str()));

        if provider.is_some() || model_name.is_some() {
            lines.push(String::new());
            lines.push("**Current Configuration:**".to_string());
            if let Some(p) = provider {
                lines.push(format!("  Provider: {}", p));
            }
            if let Some(m) = model_name {
                lines.push(format!("  Model: {}", m));
            }
        }

        lines.push(String::new());
        lines.push("_Use /model <provider/model> to switch models._".to_string());

        let text = lines.join("\n");
        ActionResult {
            success: true,
            text,
            data: None,
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "/models".to_string(),
            agent_response: "**Available Models:**\n\n**Registered Model Types:**\n  Text (Large) (`text_large`)\n  Text (Small) (`text_small`)...".to_string(),
        }]
    }
}
