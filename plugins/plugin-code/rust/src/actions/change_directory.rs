use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct ChangeDirectoryAction;

#[async_trait]
impl Action for ChangeDirectoryAction {
    fn name(&self) -> &str {
        "CHANGE_DIRECTORY"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["CD", "CWD"]
    }

    fn description(&self) -> &str {
        "Change the working directory (restricted)."
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

        let target = state.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if target.trim().is_empty() {
            return ActionResult {
                success: false,
                text: "Missing path.".to_string(),
                data: None,
                error: Some("missing_path".to_string()),
            };
        }

        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        let result = svc.change_directory(conv, target).await;
        ActionResult {
            success: result.success,
            text: if result.success {
                result.stdout
            } else {
                result.stderr
            },
            data: None,
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "cd src".to_string(),
            agent_response: "Changed directory…".to_string(),
        }]
    }
}
