use async_trait::async_trait;

use super::{ActionContext, ActionResult, N8nAction};
use crate::error::Result;

/// Action to cancel an active plugin creation job.
pub struct CancelPluginAction;

impl CancelPluginAction {
    /// Creates a new instance of the cancel plugin action.
    pub fn new() -> Self {
        Self
    }
}

impl Default for CancelPluginAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nAction for CancelPluginAction {
    fn name(&self) -> &'static str {
        "cancelPluginCreation"
    }

    fn description(&self) -> &'static str {
        "Cancel the current plugin creation job"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "stop plugin creation",
            "abort plugin creation",
            "cancel plugin",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let jobs = context.state.get("jobs").and_then(|j| j.as_array());
        if let Some(jobs) = jobs {
            return Ok(jobs.iter().any(|j| {
                let status = j.get("status").and_then(|s| s.as_str());
                status == Some("running") || status == Some("pending")
            }));
        }
        Ok(false)
    }

    async fn execute(&self, context: &ActionContext) -> Result<ActionResult> {
        let jobs = context.state.get("jobs").and_then(|j| j.as_array());

        if let Some(jobs) = jobs {
            let active_job = jobs.iter().find(|j| {
                let status = j.get("status").and_then(|s| s.as_str());
                status == Some("running") || status == Some("pending")
            });

            if let Some(job) = active_job {
                let id = job.get("id").and_then(|i| i.as_str()).unwrap_or("unknown");
                let name = job
                    .get("specification")
                    .and_then(|s| s.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");

                return Ok(ActionResult {
                    success: true,
                    text: format!(
                        "Plugin creation job has been cancelled.\n\nJob ID: {}\nPlugin: {}",
                        id, name
                    ),
                    data: Some(serde_json::json!({
                        "jobId": id,
                        "pluginName": name
                    })),
                    error: None,
                });
            }
        }

        Ok(ActionResult {
            success: false,
            text: "No active plugin creation job to cancel.".to_string(),
            data: None,
            error: None,
        })
    }
}
