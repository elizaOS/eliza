use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct ExecuteShellAction;

#[async_trait]
impl Action for ExecuteShellAction {
    fn name(&self) -> &str {
        "EXECUTE_SHELL"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["SHELL", "RUN_COMMAND", "EXEC", "TERMINAL"]
    }

    fn description(&self) -> &str {
        "Execute a shell command in the current working directory (restricted)."
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

        let command = state.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if command.trim().is_empty() {
            return ActionResult {
                success: false,
                text: "Missing command.".to_string(),
                data: None,
                error: Some("missing_command".to_string()),
            };
        }

        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        match svc.execute_shell(conv, command).await {
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
                error: Some("exec_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "run: pwd".to_string(),
            agent_response: "Running…".to_string(),
        }]
    }
}
