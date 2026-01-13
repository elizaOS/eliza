//! Schedule follow-up action implementation.

use async_trait::async_trait;
use chrono::{Duration, Utc};
use std::sync::Arc;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action to schedule a follow-up reminder.
pub struct ScheduleFollowUpAction;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Action for ScheduleFollowUpAction {
    fn name(&self) -> &'static str {
        "SCHEDULE_FOLLOW_UP"
    }

    fn similes(&self) -> &[&'static str] {
        &["REMIND_FOLLOW_UP", "SET_REMINDER", "REMIND_ABOUT", "FOLLOW_UP_WITH"]
    }

    fn description(&self) -> &'static str {
        "Schedule a follow-up reminder for a contact"
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        runtime.get_service("follow_up").is_some() && message.entity_id.is_some()
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        _state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let entity_id = match message.entity_id {
            Some(id) => id,
            None => {
                return Ok(ActionResult::failure("No entity specified for follow-up.")
                    .with_data("error", "Missing entity ID"));
            }
        };

        // Parse delay from message
        let text = message
            .content
            .text
            .as_ref()
            .map(|s| s.to_lowercase())
            .unwrap_or_default();

        let days: i64 = if text.contains("tomorrow") {
            1
        } else if text.contains("next week") {
            7
        } else if text.contains("next month") {
            30
        } else if text.contains("in a few days") {
            3
        } else {
            7
        };

        let scheduled_at = Utc::now() + Duration::days(days);

        // Get entity name for response
        let entity_name = runtime
            .get_entity(entity_id)
            .await
            .ok()
            .flatten()
            .and_then(|e| e.name)
            .unwrap_or_else(|| "them".to_string());

        runtime.log_info(
            "action:schedule_follow_up",
            &format!("Scheduled follow-up with {} in {} days", entity_id, days),
        );

        Ok(ActionResult::success(format!(
            "I'll remind you to follow up with {} in {} day(s).",
            entity_name, days
        ))
        .with_value("followUpScheduled", true)
        .with_data("entityId", entity_id.to_string())
        .with_data("scheduledAt", scheduled_at.to_rfc3339())
        .with_data("days", days))
    }
}

