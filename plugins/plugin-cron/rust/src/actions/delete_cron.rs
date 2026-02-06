use async_trait::async_trait;
use serde_json::Value;

use crate::{Action, ActionExample, ActionResult, CronService};

pub struct DeleteCronAction;

#[async_trait]
impl Action for DeleteCronAction {
    fn name(&self) -> &str {
        "DELETE_CRON"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "REMOVE_CRON",
            "CANCEL_CRON",
            "STOP_CRON",
            "DELETE_SCHEDULED_JOB",
            "REMOVE_SCHEDULED_JOB",
        ]
    }

    fn description(&self) -> &str {
        "Deletes a cron job by ID or name, removing it from the schedule permanently."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let has_delete = text.contains("delete")
            || text.contains("remove")
            || text.contains("cancel")
            || (text.contains("stop") && !text.contains("stop running"));

        let has_cron = text.contains("cron") || text.contains("job") || text.contains("schedule");

        has_delete && has_cron
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

        let job_id = extract_job_id_for_delete(text, service);

        let job_id = match job_id {
            Some(id) => id,
            None => {
                return ActionResult {
                    success: false,
                    text: "Please specify which cron job to delete (by ID or name).".to_string(),
                    data: None,
                    error: Some("No job identifier".to_string()),
                }
            }
        };

        // Get name before deleting
        let job_name = service
            .get_job(&job_id)
            .map(|j| j.name.clone())
            .unwrap_or_else(|| "unknown".to_string());

        match service.delete_job(&job_id) {
            Ok(true) => ActionResult {
                success: true,
                text: format!(
                    "Deleted cron job \"{}\" ({}).\nThe job has been permanently removed.",
                    job_name, job_id
                ),
                data: Some(serde_json::json!({
                    "jobId": job_id,
                    "jobName": job_name,
                    "deleted": true
                })),
                error: None,
            },
            Ok(false) => ActionResult {
                success: false,
                text: format!("No cron job found with ID: {}", job_id),
                data: None,
                error: Some("Job not found".to_string()),
            },
            Err(e) => ActionResult {
                success: false,
                text: format!("Failed to delete job: {}", e),
                data: None,
                error: Some(e),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "Delete the cron job called daily-check".to_string(),
                agent_response: "Deleted cron job \"daily-check\" (abc-123).\nThe job has been permanently removed.".to_string(),
            },
            ActionExample {
                user_message: "Remove cron abc-123-def-456".to_string(),
                agent_response: "Deleted cron job \"hourly-status\" (abc-123-def-456).\nThe job has been permanently removed.".to_string(),
            },
        ]
    }
}

fn extract_job_id_for_delete(text: &str, service: &CronService) -> Option<String> {
    // UUID
    let uuid_re = regex::Regex::new(
        r"(?i)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})",
    )
    .ok()?;
    if let Some(caps) = uuid_re.captures(text) {
        return Some(caps.get(1)?.as_str().to_string());
    }

    // Quoted name
    let quoted_re = regex::Regex::new(r#"["']([^"']+)["']"#).ok()?;
    if let Some(caps) = quoted_re.captures(text) {
        let name = caps.get(1)?.as_str();
        if let Some(job) = service.find_job_by_name(name) {
            return Some(job.id.clone());
        }
    }

    // "called/named X"
    let named_re = regex::Regex::new(r"(?i)(?:called|named)\s+(\S+)").ok()?;
    if let Some(caps) = named_re.captures(text) {
        let name = caps.get(1)?.as_str();
        if let Some(job) = service.find_job_by_name(name) {
            return Some(job.id.clone());
        }
    }

    None
}
