use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct WriteFileAction;

#[async_trait]
impl Action for WriteFileAction {
    fn name(&self) -> &str {
        "WRITE_FILE"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["CREATE_FILE", "SAVE_FILE", "OUTPUT_FILE"]
    }

    fn description(&self) -> &str {
        "Create or overwrite a file with given content."
    }

    async fn validate(&self, _message: &Value, _state: &Value) -> bool {
        true
    }

    async fn handler(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&mut CoderService>,
    ) -> ActionResult {
        let Some(svc) = service else {
            return ActionResult {
                success: false,
                text: "Coder service is not available.".to_string(),
                data: None,
                error: Some("missing_service".to_string()),
            };
        };

        let filepath = state.get("filepath").and_then(|v| v.as_str()).unwrap_or("");
        let content = state.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if filepath.trim().is_empty() {
            return ActionResult {
                success: false,
                text: "Missing filepath.".to_string(),
                data: None,
                error: Some("missing_filepath".to_string()),
            };
        }

        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        match svc.write_file(conv, filepath, content).await {
            Ok(()) => ActionResult {
                success: true,
                text: format!("Wrote {} ({} chars)", filepath, content.len()),
                data: None,
                error: None,
            },
            Err(err) => ActionResult {
                success: false,
                text: err,
                data: None,
                error: Some("write_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "write README.md".to_string(),
            agent_response: "Writing file…".to_string(),
        }]
    }
}
