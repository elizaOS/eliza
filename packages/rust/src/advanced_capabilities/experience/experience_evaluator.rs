//! EXPERIENCE evaluator — evaluates conversation outcomes and records experiences.

use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

use crate::basic_capabilities::evaluators::Evaluator;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{EvaluatorResult, Memory, State};

use super::service::ExperienceService;
use super::types::{Experience, ExperienceType, OutcomeType};

/// Evaluator that assesses conversation outcomes and records experiences.
pub struct ExperienceEvaluator {
    service: Arc<ExperienceService>,
}

impl ExperienceEvaluator {
    /// Create a new ExperienceEvaluator backed by the given service.
    pub fn new(service: Arc<ExperienceService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Evaluator for ExperienceEvaluator {
    fn name(&self) -> &'static str {
        "EXPERIENCE"
    }

    fn description(&self) -> &'static str {
        "Evaluates conversation outcomes and records agent experiences"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        // Run on every message to capture learning opportunities
        true
    }

    async fn evaluate(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let mut details = std::collections::HashMap::new();

        // Check if the conversation contains feedback signals
        let text = message
            .content
            .text
            .as_deref()
            .unwrap_or("");

        // Simple heuristic: look for positive/negative feedback indicators
        let has_positive = text.contains("thank") || text.contains("great") || text.contains("perfect");
        let has_negative = text.contains("wrong") || text.contains("incorrect") || text.contains("error");
        let has_correction = text.contains("actually") || text.contains("no, ") || text.contains("that's not");

        let experience_type = if has_correction {
            ExperienceType::Correction
        } else if has_positive {
            ExperienceType::Success
        } else if has_negative {
            ExperienceType::Failure
        } else {
            // Not enough signal to record
            details.insert(
                "skipped".to_string(),
                serde_json::Value::Bool(true),
            );
            return Ok(EvaluatorResult {
                score: 50,
                passed: true,
                reason: "No significant experience signal detected".to_string(),
                details,
            });
        };

        let outcome = match experience_type {
            ExperienceType::Success => OutcomeType::Positive,
            ExperienceType::Failure => OutcomeType::Negative,
            ExperienceType::Correction => OutcomeType::Mixed,
            _ => OutcomeType::Neutral,
        };

        let now = chrono::Utc::now().timestamp_millis();
        let experience = Experience {
            id: Uuid::new_v4(),
            agent_id: runtime.agent_id(),
            experience_type: experience_type.clone(),
            outcome,
            context: format!("conversation in room {:?}", message.room_id),
            action: "conversation".to_string(),
            result: text.chars().take(200).collect(),
            learning: format!("User feedback: {:?}", experience_type),
            tags: vec!["conversation".to_string(), "feedback".to_string()],
            domain: "conversation".to_string(),
            related_experiences: None,
            supersedes: None,
            confidence: 0.6,
            importance: 0.4,
            created_at: now,
            updated_at: now,
            last_accessed_at: None,
            access_count: 0,
            previous_belief: None,
            corrected_belief: None,
            embedding: None,
            memory_ids: None,
        };

        let _ = self.service.record(experience).await;

        details.insert(
            "experienceType".to_string(),
            serde_json::to_value(&experience_type).unwrap_or_default(),
        );

        Ok(EvaluatorResult {
            score: 70,
            passed: true,
            reason: format!("Recorded {:?} experience from conversation", experience_type),
            details,
        })
    }
}
