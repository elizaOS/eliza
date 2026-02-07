use async_trait::async_trait;
use serde_json::Value;

use crate::schedule::{format_schedule, parse_natural_language_schedule, parse_schedule};
use crate::types::{PayloadType, ScheduleType};
use crate::{Action, ActionExample, ActionResult, CronService};

pub struct CreateCronAction;

#[async_trait]
impl Action for CreateCronAction {
    fn name(&self) -> &str {
        "CREATE_CRON"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SCHEDULE_CRON",
            "ADD_CRON",
            "NEW_CRON",
            "CREATE_SCHEDULED_JOB",
            "SET_UP_CRON",
            "SCHEDULE_JOB",
        ]
    }

    fn description(&self) -> &str {
        "Creates a new cron job that runs on a schedule. Supports interval-based, cron expressions, and one-time schedules."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let has_schedule = text.contains("cron")
            || text.contains("schedule")
            || text.contains("every ")
            || text.contains("recurring")
            || text.contains("daily")
            || text.contains("hourly");

        let has_create = text.contains("create")
            || text.contains("add")
            || text.contains("set up")
            || text.contains("schedule")
            || text.contains("make");

        has_schedule && has_create
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

        // Try structured input from options
        if let Some(options) = message.get("options") {
            if let (Some(name), Some(schedule_str)) = (
                options.get("name").and_then(|n| n.as_str()),
                options.get("schedule").and_then(|s| s.as_str()),
            ) {
                let schedule = match parse_schedule(schedule_str) {
                    Ok(s) => s,
                    Err(e) => {
                        return ActionResult {
                            success: false,
                            text: format!("Invalid schedule: {}", e),
                            data: None,
                            error: Some(e),
                        }
                    }
                };

                let prompt = options
                    .get("prompt")
                    .and_then(|p| p.as_str())
                    .unwrap_or("Run scheduled task");

                let payload = PayloadType::Prompt {
                    text: prompt.to_string(),
                };

                return match service.create_job(
                    name.to_string(),
                    options.get("description").and_then(|d| d.as_str()).map(String::from),
                    schedule,
                    payload,
                    options.get("max_runs").and_then(|m| m.as_u64()),
                    options.get("room_id").and_then(|r| r.as_str()).map(String::from),
                ) {
                    Ok(job) => {
                        let schedule_str = format_schedule(&job.schedule);
                        ActionResult {
                            success: true,
                            text: format!(
                                "Created cron job \"{}\"\n- ID: {}\n- Schedule: {}\n- Status: {:?}",
                                job.name, job.id, schedule_str, job.state
                            ),
                            data: serde_json::to_value(&job).ok(),
                            error: None,
                        }
                    }
                    Err(e) => ActionResult {
                        success: false,
                        text: format!("Failed to create job: {}", e),
                        data: None,
                        error: Some(e),
                    },
                };
            }
        }

        // Natural language parsing
        let (name, schedule, prompt) = parse_create_request(text);

        let schedule = match schedule {
            Some(s) => s,
            None => {
                return ActionResult {
                    success: false,
                    text: "Could not understand the schedule. Try:\n- \"every 5 minutes\"\n- \"daily at 9am\"\n- A cron expression like \"0 9 * * 1-5\"".to_string(),
                    data: None,
                    error: Some("Could not parse schedule".to_string()),
                }
            }
        };

        let payload = PayloadType::Prompt {
            text: prompt.unwrap_or_else(|| "Run scheduled task".to_string()),
        };

        match service.create_job(name, None, schedule, payload, None, None) {
            Ok(job) => {
                let schedule_str = format_schedule(&job.schedule);
                ActionResult {
                    success: true,
                    text: format!(
                        "Created cron job \"{}\"\n- ID: {}\n- Schedule: {}\n- Status: {:?}",
                        job.name, job.id, schedule_str, job.state
                    ),
                    data: serde_json::to_value(&job).ok(),
                    error: None,
                }
            }
            Err(e) => ActionResult {
                success: false,
                text: format!("Failed to create job: {}", e),
                data: None,
                error: Some(e),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "Create a cron job to check the news every hour".to_string(),
                agent_response: "Created cron job \"check the news\"\n- ID: abc-123\n- Schedule: every 1 hour\n- Status: Active".to_string(),
            },
            ActionExample {
                user_message: "Schedule a daily reminder at 9am to review my goals".to_string(),
                agent_response: "Created cron job \"review my goals\"\n- ID: def-456\n- Schedule: cron: 0 9 * * *\n- Status: Active".to_string(),
            },
        ]
    }
}

/// Extracts name, schedule, and prompt from a natural language create request.
fn parse_create_request(text: &str) -> (String, Option<ScheduleType>, Option<String>) {
    let mut name = "Unnamed cron job".to_string();
    let mut prompt = None;

    // Extract "to <action>" pattern
    let to_re = regex::Regex::new(r"(?i)(?:to|that)\s+(.+?)(?:\s+every|\s+at\s+\d|$)").ok();
    if let Some(re) = to_re {
        if let Some(caps) = re.captures(text) {
            if let Some(m) = caps.get(1) {
                let action_text = m.as_str().trim();
                name = action_text.chars().take(50).collect();
                prompt = Some(action_text.to_string());
            }
        }
    }

    // Extract "called/named X"
    let name_re = regex::Regex::new(r#"(?i)(?:called|named)\s+["']?([^"']+)["']?"#).ok();
    if let Some(re) = name_re {
        if let Some(caps) = re.captures(text) {
            if let Some(m) = caps.get(1) {
                name = m.as_str().trim().to_string();
            }
        }
    }

    // Try to extract schedule from natural language
    let schedule = parse_natural_language_schedule(text);

    // If natural language failed, try raw schedule extraction
    let schedule = schedule.or_else(|| {
        let every_re =
            regex::Regex::new(r"(?i)every\s+(\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?))")
                .ok()?;
        if let Some(caps) = every_re.captures(text) {
            return parse_natural_language_schedule(&format!("every {}", caps.get(1)?.as_str()));
        }
        None
    });

    (name, schedule, prompt)
}
