//! FORM_EXTRACTOR evaluator — extracts form field values from conversation.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::evaluators::Evaluator;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{EvaluatorResult, Memory, State};

use super::service::FormService;
use super::types::*;

/// Evaluator that extracts form field values from user messages.
pub struct FormExtractorEvaluator {
    service: Arc<FormService>,
}

impl FormExtractorEvaluator {
    /// Create a new FormExtractorEvaluator.
    pub fn new(service: Arc<FormService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Evaluator for FormExtractorEvaluator {
    fn name(&self) -> &'static str {
        "FORM_EXTRACTOR"
    }

    fn description(&self) -> &'static str {
        "Extracts form field values from user messages during active form sessions"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        // Only run when there could be an active session
        message.entity_id.is_some() && message.room_id.is_some()
    }

    async fn evaluate(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let entity_id = message
            .entity_id
            .ok_or_else(|| crate::error::PluginError::InvalidInput("No entity ID".to_string()))?;
        let room_id = message
            .room_id
            .ok_or_else(|| crate::error::PluginError::InvalidInput("No room ID".to_string()))?;

        let session = match self.service.get_active_session(entity_id, room_id).await {
            Some(s) => s,
            None => {
                return Ok(EvaluatorResult {
                    score: 0,
                    passed: true,
                    reason: "No active form session".to_string(),
                    details: std::collections::HashMap::new(),
                });
            }
        };

        let definition = match self.service.get_definition(&session.form_id).await {
            Some(d) => d,
            None => {
                return Ok(EvaluatorResult {
                    score: 0,
                    passed: false,
                    reason: "Form definition not found".to_string(),
                    details: std::collections::HashMap::new(),
                });
            }
        };

        let text = message
            .content
            .text
            .as_deref()
            .unwrap_or("");

        if text.is_empty() {
            return Ok(EvaluatorResult {
                score: 0,
                passed: true,
                reason: "Empty message".to_string(),
                details: std::collections::HashMap::new(),
            });
        }

        // Simple extraction: look for fields that are empty and try to match the message
        // In production, this would use the LLM for sophisticated extraction.
        let mut extracted_count = 0u32;

        for control in &definition.controls {
            let field_state = session.fields.get(&control.key);
            let is_empty = field_state
                .map(|f| f.status == FieldStatus::Empty)
                .unwrap_or(true);

            if !is_empty {
                continue;
            }

            // Simple heuristic: if the message looks like it could be a value for this field
            let value = match control.control_type.as_str() {
                "email" => {
                    if text.contains('@') && text.contains('.') {
                        Some(serde_json::Value::String(text.trim().to_string()))
                    } else {
                        None
                    }
                }
                "number" => text
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .map(|n| serde_json::json!(n)),
                "boolean" => {
                    let lower = text.to_lowercase();
                    if lower == "yes" || lower == "true" {
                        Some(serde_json::Value::Bool(true))
                    } else if lower == "no" || lower == "false" {
                        Some(serde_json::Value::Bool(false))
                    } else {
                        None
                    }
                }
                _ => {
                    // For text fields, if the last asked field matches, take the value
                    if session.last_asked_field.as_deref() == Some(&control.key) {
                        Some(serde_json::Value::String(text.trim().to_string()))
                    } else {
                        None
                    }
                }
            };

            if let Some(val) = value {
                let _ = self
                    .service
                    .update_field(
                        &session.id,
                        &control.key,
                        val,
                        0.7,
                        FieldSource::Extraction,
                    )
                    .await;
                extracted_count += 1;
            }
        }

        let mut details = std::collections::HashMap::new();
        details.insert(
            "extractedCount".to_string(),
            serde_json::json!(extracted_count),
        );
        details.insert(
            "sessionId".to_string(),
            serde_json::Value::String(session.id),
        );

        Ok(EvaluatorResult {
            score: if extracted_count > 0 { 80 } else { 30 },
            passed: true,
            reason: format!("Extracted {} field values", extracted_count),
            details,
        })
    }
}
