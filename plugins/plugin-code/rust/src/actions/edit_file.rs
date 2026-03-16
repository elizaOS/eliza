use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct EditFileAction;

#[async_trait]
impl Action for EditFileAction {
    fn name(&self) -> &str {
        "EDIT_FILE"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["REPLACE_IN_FILE", "PATCH_FILE", "MODIFY_FILE"]
    }

    fn description(&self) -> &str {
        "Replace a substring in a file (single replacement)."
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
        let old_str = state.get("old_str").and_then(|v| v.as_str()).unwrap_or("");
        let new_str = state.get("new_str").and_then(|v| v.as_str()).unwrap_or("");

        if filepath.trim().is_empty() || old_str.is_empty() {
            return ActionResult {
                success: false,
                text: "Missing filepath or old_str.".to_string(),
                data: None,
                error: Some("missing_args".to_string()),
            };
        }

        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        match svc.edit_file(conv, filepath, old_str, new_str).await {
            Ok(()) => ActionResult {
                success: true,
                text: format!("Edited {}", filepath),
                data: None,
                error: None,
            },
            Err(err) => ActionResult {
                success: false,
                text: err,
                data: None,
                error: Some("edit_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "edit file".to_string(),
            agent_response: "Editing…".to_string(),
        }]
    }
}
