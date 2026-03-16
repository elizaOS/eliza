use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct GitAction;

#[async_trait]
impl Action for GitAction {
    fn name(&self) -> &str {
        "GIT"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["GIT_COMMAND", "GIT_RUN"]
    }

    fn description(&self) -> &str {
        "Run a git command (restricted)."
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

        let args = state.get("args").and_then(|v| v.as_str()).unwrap_or("");
        if args.trim().is_empty() {
            return ActionResult {
                success: false,
                text: "Missing args.".to_string(),
                data: None,
                error: Some("missing_args".to_string()),
            };
        }

        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        match svc.git(conv, args).await {
            Ok(result) => ActionResult {
                success: result.success,
                text: if result.success {
                    result.stdout
                } else {
                    result.stderr
                },
                data: None,
                error: None,
            },
            Err(err) => ActionResult {
                success: false,
                text: err.to_string(),
                data: None,
                error: Some("git_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "git status".to_string(),
            agent_response: "Running git…".to_string(),
        }]
    }
}
