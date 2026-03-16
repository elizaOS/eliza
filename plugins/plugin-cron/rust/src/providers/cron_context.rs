use async_trait::async_trait;
use serde_json::Value;

use crate::schedule::format_schedule;
use crate::types::JobState;
use crate::{CronService, Provider, ProviderResult};

/// Provider that exposes cron job context to the agent.
pub struct CronContextProvider;

#[async_trait]
impl Provider for CronContextProvider {
    fn name(&self) -> &str {
        "CRON_CONTEXT"
    }

    fn description(&self) -> &str {
        "Provides information about scheduled cron jobs"
    }

    fn position(&self) -> i32 {
        50
    }

    async fn get(
        &self,
        _message: &Value,
        _state: &Value,
        service: Option<&CronService>,
    ) -> ProviderResult {
        let service = match service {
            Some(s) => s,
            None => {
                return ProviderResult {
                    values: serde_json::json!({
                        "hasCronService": false,
                        "cronJobCount": 0
                    }),
                    text: String::new(),
                    data: serde_json::json!({"available": false}),
                }
            }
        };

        let all_jobs = service.list_jobs(None);
        let active_jobs: Vec<_> = all_jobs
            .iter()
            .filter(|j| j.state == JobState::Active)
            .collect();
        let paused_jobs: Vec<_> = all_jobs
            .iter()
            .filter(|j| j.state == JobState::Paused)
            .collect();
        let failed_jobs: Vec<_> = all_jobs
            .iter()
            .filter(|j| j.state == JobState::Failed)
            .collect();

        let mut lines = Vec::new();

        if all_jobs.is_empty() {
            lines.push("No cron jobs are scheduled.".to_string());
        } else {
            lines.push(format!(
                "Scheduled Jobs ({} active, {} paused):",
                active_jobs.len(),
                paused_jobs.len()
            ));

            if !failed_jobs.is_empty() {
                lines.push("\nRecently failed:".to_string());
                for job in failed_jobs.iter().take(3) {
                    lines.push(format!("- {}: failed", job.name));
                }
            }

            if active_jobs.len() <= 10 {
                lines.push("\nAll active jobs:".to_string());
                for job in &active_jobs {
                    let schedule_str = format_schedule(&job.schedule);
                    let next = job
                        .next_run
                        .map(|nr| nr.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                        .unwrap_or_else(|| "not scheduled".to_string());
                    lines.push(format!("- {} ({}) - next: {}", job.name, schedule_str, next));
                }
            } else {
                lines.push(format!(
                    "\n{} active jobs total. Use \"list crons\" to see all.",
                    active_jobs.len()
                ));
            }
        }

        let jobs_data: Vec<Value> = all_jobs
            .iter()
            .map(|j| {
                serde_json::json!({
                    "id": j.id,
                    "name": j.name,
                    "state": j.state,
                    "schedule": format_schedule(&j.schedule),
                    "next_run": j.next_run.map(|nr| nr.to_rfc3339()),
                })
            })
            .collect();

        ProviderResult {
            values: serde_json::json!({
                "hasCronService": true,
                "cronJobCount": all_jobs.len(),
                "activeJobCount": active_jobs.len(),
                "pausedJobCount": paused_jobs.len(),
                "failedJobCount": failed_jobs.len(),
            }),
            text: lines.join("\n"),
            data: serde_json::json!({
                "available": true,
                "jobs": jobs_data,
            }),
        }
    }
}
