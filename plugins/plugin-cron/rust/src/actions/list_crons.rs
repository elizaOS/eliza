use async_trait::async_trait;
use serde_json::Value;

use crate::schedule::format_schedule;
use crate::types::JobState;
use crate::{Action, ActionExample, ActionResult, CronService};

pub struct ListCronsAction;

#[async_trait]
impl Action for ListCronsAction {
    fn name(&self) -> &str {
        "LIST_CRONS"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SHOW_CRONS",
            "GET_CRONS",
            "VIEW_CRONS",
            "LIST_SCHEDULED_JOBS",
            "SHOW_SCHEDULED_JOBS",
            "MY_CRONS",
            "CRON_STATUS",
        ]
    }

    fn description(&self) -> &str {
        "Lists all cron jobs. Can filter by state or show details of a specific job."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        let has_list = text.contains("list")
            || text.contains("show")
            || text.contains("view")
            || text.contains("get")
            || text.contains("what");

        let has_cron = text.contains("cron")
            || text.contains("scheduled")
            || text.contains("job")
            || text.contains("schedule");

        has_list && has_cron
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
            .unwrap_or("")
            .to_lowercase();

        // Determine filter
        let filter = if text.contains("active") || text.contains("enabled") {
            Some(JobState::Active)
        } else if text.contains("paused") || text.contains("disabled") {
            Some(JobState::Paused)
        } else if text.contains("completed") || text.contains("finished") {
            Some(JobState::Completed)
        } else if text.contains("failed") {
            Some(JobState::Failed)
        } else {
            None
        };

        let jobs = service.list_jobs(filter.clone());

        if jobs.is_empty() {
            let filter_desc = filter
                .as_ref()
                .map(|f| format!(" with state {:?}", f))
                .unwrap_or_default();
            return ActionResult {
                success: true,
                text: format!("No cron jobs found{}.", filter_desc),
                data: Some(serde_json::json!({"jobs": [], "count": 0})),
                error: None,
            };
        }

        let mut lines = vec![format!(
            "Found {} cron job{}:\n",
            jobs.len(),
            if jobs.len() == 1 { "" } else { "s" }
        )];

        for job in &jobs {
            let schedule_str = format_schedule(&job.schedule);
            let next_run = job
                .next_run
                .map(|nr| nr.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| "not scheduled".to_string());

            lines.push(format!(
                "- {} ({:?})\n  ID: {}\n  Schedule: {}\n  Next run: {}\n  Runs: {}",
                job.name, job.state, job.id, schedule_str, next_run, job.run_count
            ));
        }

        let data = serde_json::json!({
            "count": jobs.len(),
            "jobs": jobs.iter().map(|j| serde_json::json!({
                "id": j.id,
                "name": j.name,
                "state": j.state,
                "schedule": format_schedule(&j.schedule),
                "run_count": j.run_count,
            })).collect::<Vec<_>>()
        });

        ActionResult {
            success: true,
            text: lines.join("\n"),
            data: Some(data),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "List my cron jobs".to_string(),
                agent_response: "Found 2 cron jobs:\n\n- Daily news check (Active)\n  ID: abc-123\n  Schedule: cron: 0 9 * * *\n  Runs: 5".to_string(),
            },
            ActionExample {
                user_message: "Show all active scheduled jobs".to_string(),
                agent_response: "Found 1 cron job:\n\n- Hourly status check (Active)\n  ID: def-456\n  Schedule: every 1 hour\n  Runs: 120".to_string(),
            },
        ]
    }
}
