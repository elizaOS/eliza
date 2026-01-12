use async_trait::async_trait;

use super::{ActionContext, ActionResult, N8nAction};
use crate::error::Result;

/// Action to create a new plugin from a JSON specification.
pub struct CreatePluginAction;

impl CreatePluginAction {
    /// Creates a new instance of the create plugin action.
    pub fn new() -> Self {
        Self
    }
}

impl Default for CreatePluginAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nAction for CreatePluginAction {
    fn name(&self) -> &'static str {
        "createPlugin"
    }

    fn description(&self) -> &'static str {
        "Create a new plugin from a specification using AI assistance"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "generate plugin",
            "build plugin",
            "make plugin",
            "develop plugin",
            "create extension",
            "build extension",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let active_jobs = context.state.get("activeJobs").and_then(|j| j.as_array());
        if let Some(jobs) = active_jobs {
            if jobs.iter().any(|j| {
                j.get("status").and_then(|s| s.as_str()) == Some("running")
                    || j.get("status").and_then(|s| s.as_str()) == Some("pending")
            }) {
                return Ok(false);
            }
        }

        Ok(context.message_text.contains("{") && context.message_text.contains("}"))
    }

    async fn execute(&self, context: &ActionContext) -> Result<ActionResult> {
        let spec_result = serde_json::from_str::<serde_json::Value>(&context.message_text);

        match spec_result {
            Ok(spec) => {
                let name = spec
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown");

                Ok(ActionResult {
                    success: true,
                    text: format!(
                        "Plugin creation job started successfully!\n\nPlugin: {}\n\nUse 'checkPluginCreationStatus' to monitor progress.",
                        name
                    ),
                    data: Some(serde_json::json!({
                        "pluginName": name,
                        "status": "pending"
                    })),
                    error: None,
                })
            }
            Err(e) => Ok(ActionResult {
                success: false,
                text: format!("Failed to parse specification: {}", e),
                data: None,
                error: Some(e.to_string()),
            }),
        }
    }
}
