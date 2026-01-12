use async_trait::async_trait;

use super::{ActionContext, ActionResult, N8nAction};
use crate::error::Result;

/// Action to check the status of a plugin creation job.
pub struct CheckStatusAction;

impl CheckStatusAction {
    /// Creates a new instance of the check status action.
    pub fn new() -> Self {
        Self
    }
}

impl Default for CheckStatusAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nAction for CheckStatusAction {
    fn name(&self) -> &'static str {
        "checkPluginCreationStatus"
    }

    fn description(&self) -> &'static str {
        "Check the status of a plugin creation job"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "plugin status",
            "check plugin progress",
            "plugin creation status",
            "get plugin status",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let jobs = context.state.get("jobs").and_then(|j| j.as_array());
        Ok(jobs.map(|j| !j.is_empty()).unwrap_or(false))
    }

    async fn execute(&self, context: &ActionContext) -> Result<ActionResult> {
        let jobs = context.state.get("jobs").and_then(|j| j.as_array());

        match jobs {
            Some(jobs) if !jobs.is_empty() => {
                let job = &jobs[0];
                let status = job
                    .get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("unknown");
                let progress = job.get("progress").and_then(|p| p.as_f64()).unwrap_or(0.0);
                let name = job
                    .get("specification")
                    .and_then(|s| s.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");

                Ok(ActionResult {
                    success: true,
                    text: format!(
                        "Plugin Creation Status\n\nPlugin: {}\nStatus: {}\nProgress: {:.0}%",
                        name,
                        status.to_uppercase(),
                        progress
                    ),
                    data: Some(serde_json::json!({
                        "status": status,
                        "progress": progress,
                        "pluginName": name
                    })),
                    error: None,
                })
            }
            _ => Ok(ActionResult {
                success: false,
                text: "No plugin creation jobs found.".to_string(),
                data: None,
                error: None,
            }),
        }
    }
}
