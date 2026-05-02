//! RECORD_EXPERIENCE action implementation.

use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

use crate::basic_capabilities::actions::Action;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::service::ExperienceService;
use super::types::{Experience, ExperienceType, OutcomeType};

/// Action that records an agent experience for future reference.
pub struct RecordExperienceAction {
    service: Arc<ExperienceService>,
}

impl RecordExperienceAction {
    /// Create a new RecordExperienceAction backed by the given service.
    pub fn new(service: Arc<ExperienceService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for RecordExperienceAction {
    fn name(&self) -> &'static str {
        "RECORD_EXPERIENCE"
    }

    fn similes(&self) -> &[&'static str] {
        &["LEARN", "REMEMBER_EXPERIENCE", "LOG_EXPERIENCE"]
    }

    fn description(&self) -> &'static str {
        "Record an experience for future learning and reference"
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
        // Extract parameters from state or message
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let experience_type = params
            .get("type")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<ExperienceType>(&format!("\"{}\"", s)).ok())
            .unwrap_or(ExperienceType::Learning);

        let outcome = params
            .get("outcome")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<OutcomeType>(&format!("\"{}\"", s)).ok())
            .unwrap_or(OutcomeType::Neutral);

        let context_str = params
            .get("context")
            .and_then(|v| v.as_str())
            .unwrap_or("unspecified")
            .to_string();

        let action_str = params
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let result_str = params
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let learning_str = params
            .get("learning")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let domain = params
            .get("domain")
            .and_then(|v| v.as_str())
            .unwrap_or("general")
            .to_string();

        let tags: Vec<String> = params
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let confidence = params
            .get("confidence")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.7);

        let importance = params
            .get("importance")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.5);

        let now = chrono::Utc::now().timestamp_millis();

        let experience = Experience {
            id: Uuid::new_v4(),
            agent_id: runtime.agent_id(),
            experience_type,
            outcome,
            context: context_str,
            action: action_str,
            result: result_str,
            learning: learning_str.clone(),
            tags,
            domain,
            related_experiences: None,
            supersedes: None,
            confidence,
            importance,
            created_at: now,
            updated_at: now,
            last_accessed_at: None,
            access_count: 0,
            previous_belief: None,
            corrected_belief: None,
            embedding: None,
            memory_ids: None,
        };

        let event = self
            .service
            .record(experience)
            .await
            .map_err(|e| crate::error::PluginError::ActionFailed(e.to_string()))?;

        Ok(ActionResult::success(format!(
            "Experience recorded: {}",
            learning_str
        ))
        .with_value("success", true)
        .with_data("experienceId", event.experience_id.to_string())
        .with_data("actionName", "RECORD_EXPERIENCE"))
    }
}
