use async_trait::async_trait;
use serde_json::Value;

use crate::{Action, ActionExample, ActionResult, CronService};

pub struct RunCronAction;

#[async_trait]
impl Action for RunCronAction {
    fn name(&self) -> &str {
        "RUN_CRON"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "EXECUTE_CRON",
            "TRIGGER_CRON",
            "FIRE_CRON",
            "RUN_SCHEDULED_JOB",
            "EXECUTE_JOB",
            "TRIGGER_JOB",
        ]
    }

    fn description(&self) -> &str {
        "Manually runs a cron job immediately, regardless of its schedule."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let has_run = text.contains("run")
            || text.contains("execute")
            || text.contains("trigger")
            || text.contains("fire");

        let has_cron = text.contains("cron") || text.contains("job") || text.contains("schedule");

        // Exclude "run every" which is for creating jobs
        let is_create = text.contains("run every") || text.contains("runs every");

        has_run && has_cron && !is_create
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

        let job_id = extract_job_id_for_run(text, service);

        let job_id = match job_id {
            Some(id) => id,
            None => {
                return ActionResult {
                    success: false,
                    text: "Please specify which cron job to run (by ID or name).".to_string(),
                    data: None,
                    error: Some("No job identifier".to_string()),
                }
            }
        };

        // Get name before running
        let job_name = service
            .get_job(&job_id)
            .map(|j| j.name.clone())
            .unwrap_or_else(|| "unknown".to_string());

        match service.run_job(&job_id) {
            Ok(job) => ActionResult {
                success: true,
                text: format!(
                    "Ran cron job \"{}\" ({})\n- Status: {:?}\n- Run count: {}",
                    job_name, job.id, job.state, job.run_count
                ),
                data: serde_json::to_value(&job).ok(),
                error: None,
            },
            Err(e) => ActionResult {
                success: false,
                text: format!("Failed to run job: {}", e),
                data: None,
                error: Some(e),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "Run the cron job called daily-check now".to_string(),
                agent_response: "Ran cron job \"daily-check\" (abc-123)\n- Status: Active\n- Run count: 6".to_string(),
            },
            ActionExample {
                user_message: "Execute cron abc-123-def-456".to_string(),
                agent_response: "Ran cron job \"status-checker\" (abc-123-def-456)\n- Status: Active\n- Run count: 121".to_string(),
            },
        ]
    }
}

fn extract_job_id_for_run(text: &str, service: &CronService) -> Option<String> {
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
