use async_trait::async_trait;

use super::{ActionContext, ActionResult, N8nAction};
use crate::error::Result;

/// Action to create a plugin from a natural language description.
pub struct CreateFromDescriptionAction;

impl CreateFromDescriptionAction {
    /// Creates a new instance of the create from description action.
    pub fn new() -> Self {
        Self
    }
}

impl Default for CreateFromDescriptionAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nAction for CreateFromDescriptionAction {
    fn name(&self) -> &'static str {
        "createPluginFromDescription"
    }

    fn description(&self) -> &'static str {
        "Create a plugin from a natural language description"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "describe plugin",
            "plugin from description",
            "explain plugin",
            "I need a plugin that",
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

        Ok(context.message_text.len() > 20)
    }

    async fn execute(&self, context: &ActionContext) -> Result<ActionResult> {
        let description = &context.message_text;
        let lower_desc = description.to_lowercase();

        let plugin_type = if lower_desc.contains("weather") {
            "weather"
        } else if lower_desc.contains("database") || lower_desc.contains("sql") {
            "database"
        } else if lower_desc.contains("api") || lower_desc.contains("rest") {
            "api"
        } else if lower_desc.contains("todo") || lower_desc.contains("task") {
            "todo"
        } else if lower_desc.contains("email") || lower_desc.contains("mail") {
            "email"
        } else {
            "custom"
        };

        let name = format!("@elizaos/plugin-{}", plugin_type);
        let truncated_desc = if description.len() > 200 {
            &description[..200]
        } else {
            description
        };

        Ok(ActionResult {
            success: true,
            text: format!(
                "Creating plugin based on your description!\n\nPlugin: {}\nDescription: {}\n\nUse 'checkPluginCreationStatus' to monitor progress.",
                name, truncated_desc
            ),
            data: Some(serde_json::json!({
                "pluginName": name,
                "description": truncated_desc,
                "status": "pending"
            })),
            error: None,
        })
    }
}
