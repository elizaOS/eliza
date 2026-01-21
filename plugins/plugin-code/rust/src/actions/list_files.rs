use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct ListFilesAction;

#[async_trait]
impl Action for ListFilesAction {
    fn name(&self) -> &str {
        "LIST_FILES"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["LS", "LIST_DIR", "LIST_DIRECTORY", "DIR"]
    }

    fn description(&self) -> &str {
        "List files in a directory."
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

        let dirpath = state.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        match svc.list_files(conv, dirpath).await {
            Ok(items) => ActionResult {
                success: true,
                text: if items.is_empty() {
                    "(empty)".to_string()
                } else {
                    items.join("\n")
                },
                data: None,
                error: None,
            },
            Err(err) => ActionResult {
                success: false,
                text: err,
                data: None,
                error: Some("list_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "list files".to_string(),
            agent_response: "Listing…".to_string(),
        }]
    }
}
