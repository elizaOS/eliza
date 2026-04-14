//! CHARACTER_EVOLUTION evaluator — evaluates whether character traits should evolve.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::evaluators::Evaluator;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{EvaluatorResult, Memory, State};

use super::character_file_manager::CharacterFileManager;

/// Evaluator that monitors conversation patterns and suggests character evolution.
pub struct CharacterEvolutionEvaluator {
    service: Arc<CharacterFileManager>,
}

impl CharacterEvolutionEvaluator {
    /// Create a new CharacterEvolutionEvaluator.
    pub fn new(service: Arc<CharacterFileManager>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Evaluator for CharacterEvolutionEvaluator {
    fn name(&self) -> &'static str {
        "CHARACTER_EVOLUTION"
    }

    fn description(&self) -> &'static str {
        "Evaluates whether character traits should evolve based on interaction patterns"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn evaluate(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let mut details = std::collections::HashMap::new();

        let text = message
            .content
            .text
            .as_deref()
            .unwrap_or("");

        // Simple heuristic: detect user preference signals
        let wants_more_formal = text.contains("more formal")
            || text.contains("be professional")
            || text.contains("less casual");
        let wants_more_casual = text.contains("more casual")
            || text.contains("be friendly")
            || text.contains("less formal");
        let wants_more_detail = text.contains("more detail")
            || text.contains("explain more")
            || text.contains("be thorough");
        let wants_less_detail = text.contains("be brief")
            || text.contains("shorter")
            || text.contains("too long");

        let mut suggested_changes = Vec::new();

        if wants_more_formal {
            suggested_changes.push(("formality", 0.8));
        }
        if wants_more_casual {
            suggested_changes.push(("formality", 0.3));
        }
        if wants_more_detail {
            suggested_changes.push(("verbosity", 0.8));
        }
        if wants_less_detail {
            suggested_changes.push(("verbosity", 0.3));
        }

        // Record per-user preferences if entity is available
        if let Some(entity_id) = message.entity_id {
            for (key, value) in &suggested_changes {
                let _ = self
                    .service
                    .set_preference(entity_id, key, &value.to_string())
                    .await;
            }
        }

        if suggested_changes.is_empty() {
            details.insert(
                "evolution".to_string(),
                serde_json::Value::String("none_detected".to_string()),
            );
            return Ok(EvaluatorResult {
                score: 30,
                passed: true,
                reason: "No evolution signals detected".to_string(),
                details,
            });
        }

        // Apply trait changes
        for (trait_name, intensity) in &suggested_changes {
            let _ = self.service.update_trait(trait_name, *intensity).await;
        }

        details.insert(
            "suggestedChanges".to_string(),
            serde_json::json!(suggested_changes
                .iter()
                .map(|(k, v)| format!("{}={:.1}", k, v))
                .collect::<Vec<_>>()),
        );

        Ok(EvaluatorResult {
            score: 80,
            passed: true,
            reason: format!(
                "Detected {} evolution signals",
                suggested_changes.len()
            ),
            details,
        })
    }
}
