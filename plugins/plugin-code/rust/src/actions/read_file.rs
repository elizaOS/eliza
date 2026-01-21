use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct ReadFileAction;

#[async_trait]
impl Action for ReadFileAction {
    fn name(&self) -> &str {
        "READ_FILE"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "VIEW_FILE",
            "OPEN_FILE",
            "CAT_FILE",
            "SHOW_FILE",
            "GET_FILE",
        ]
    }

    fn description(&self) -> &str {
        "Read and return a file's contents."
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

        let filepath = state
            .get("filepath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
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

        match svc.read_file(conv, &filepath).await {
            Ok(content) => ActionResult {
                success: true,
                text: content,
                data: None,
                error: None,
            },
            Err(err) => ActionResult {
                success: false,
                text: err,
                data: None,
                error: Some("read_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "read src/lib.rs".to_string(),
            agent_response: "Reading file…".to_string(),
        }]
    }
}
