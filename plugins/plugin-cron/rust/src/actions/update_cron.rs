use async_trait::async_trait;
use serde_json::Value;

use crate::schedule::{format_schedule, parse_natural_language_schedule};
use crate::types::JobUpdate;
use crate::{Action, ActionExample, ActionResult, CronService};

pub struct UpdateCronAction;

#[async_trait]
impl Action for UpdateCronAction {
    fn name(&self) -> &str {
        "UPDATE_CRON"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "MODIFY_CRON",
            "EDIT_CRON",
            "CHANGE_CRON",
            "ENABLE_CRON",
            "DISABLE_CRON",
            "PAUSE_CRON",
            "RESUME_CRON",
        ]
    }

    fn description(&self) -> &str {
        "Updates an existing cron job. Can pause/resume, change schedules, or modify other properties."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let has_update = text.contains("update")
            || text.contains("modify")
            || text.contains("edit")
            || text.contains("change")
            || text.contains("enable")
            || text.contains("disable")
            || text.contains("pause")
            || text.contains("resume");

        let has_cron = text.contains("cron") || text.contains("job") || text.contains("schedule");

        has_update && has_cron
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut CronService>,
    ) -> ActionResult {
        let service = match service {
            Some(s) => s,
            None => {
                return ActionResult {
                    success: false,
                    text: "Cron service is not available.".to_string(),
                    data: None,
                    error: Some("missing_service".to_string()),
                }
            }
        };

        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Extract job identifier
        let job_id = extract_job_id(text, service);

        let job_id = match job_id {
            Some(id) => id,
            None => {
                return ActionResult {
                    success: false,
                    text: "Please specify which cron job to update (by ID or name).".to_string(),
                    data: None,
                    error: Some("No job identifier".to_string()),
                }
            }
        };

        // Parse update intent
        let updates = parse_update_intent(text);

        if updates.name.is_none()
            && updates.schedule.is_none()
            && updates.state.is_none()
            && updates.payload.is_none()
        {
            return ActionResult {
                success: false,
                text: "Please specify what to update (e.g. pause, resume, change schedule)."
                    .to_string(),
                data: None,
                error: Some("No updates specified".to_string()),
            };
        }

        match service.update_job(&job_id, updates) {
            Ok(job) => {
                let schedule_str = format_schedule(&job.schedule);
                ActionResult {
                    success: true,
                    text: format!(
                        "Updated cron job \"{}\" ({})\n- Schedule: {}\n- State: {:?}",
                        job.name, job.id, schedule_str, job.state
                    ),
                    data: serde_json::to_value(&job).ok(),
                    error: None,
                }
            }
            Err(e) => ActionResult {
                success: false,
                text: format!("Failed to update job: {}", e),
                data: None,
                error: Some(e),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "Pause the cron job called daily-check".to_string(),
                agent_response: "Updated cron job \"daily-check\" (abc-123)\n- State: Paused"
                    .to_string(),
            },
            ActionExample {
                user_message: "Change cron abc-123 to run every 2 hours".to_string(),
                agent_response:
                    "Updated cron job \"status checker\" (abc-123)\n- Schedule: every 2 hours"
                        .to_string(),
            },
        ]
    }
}

/// Extracts a job ID from text (UUID or name lookup).
fn extract_job_id(text: &str, service: &CronService) -> Option<String> {
    // Try UUID pattern
    let uuid_re = regex::Regex::new(
        r"(?i)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})",
    )
    .ok()?;
    if let Some(caps) = uuid_re.captures(text) {
        return Some(caps.get(1)?.as_str().to_string());
    }

    // Try quoted name
    let quoted_re = regex::Regex::new(r#"["']([^"']+)["']"#).ok()?;
    if let Some(caps) = quoted_re.captures(text) {
        let name = caps.get(1)?.as_str();
        if let Some(job) = service.find_job_by_name(name) {
            return Some(job.id.clone());
        }
    }

    // Try "called/named X"
    let named_re = regex::Regex::new(r"(?i)(?:called|named)\s+(\S+)").ok()?;
    if let Some(caps) = named_re.captures(text) {
        let name = caps.get(1)?.as_str();
        if let Some(job) = service.find_job_by_name(name) {
            return Some(job.id.clone());
        }
    }

    None
}

/// Parses update intent from natural language text.
fn parse_update_intent(text: &str) -> JobUpdate {
    let mut updates = JobUpdate::default();
    let lower = text.to_lowercase();

    // Pause / resume
    if lower.contains("pause") || lower.contains("disable") {
        updates.state = Some(crate::types::JobState::Paused);
    } else if lower.contains("resume") || lower.contains("enable") {
        updates.state = Some(crate::types::JobState::Active);
    }

    // Schedule change
    if let Some(schedule) = parse_natural_language_schedule(text) {
        updates.schedule = Some(schedule);
    }

    // Name change: "rename to X"
    let rename_re = regex::Regex::new(r#"(?i)rename\s+(?:to|as)\s+["']?([^"']+)["']?"#).ok();
    if let Some(re) = rename_re {
        if let Some(caps) = re.captures(text) {
            if let Some(m) = caps.get(1) {
                updates.name = Some(m.as_str().trim().to_string());
            }
        }
    }

    updates
}
