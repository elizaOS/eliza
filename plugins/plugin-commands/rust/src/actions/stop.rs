use async_trait::async_trait;
use serde_json::Value;
use tracing::info;

use crate::registry::CommandRegistry;
use crate::{Action, ActionExample, ActionResult};

pub struct StopCommandAction;

#[async_trait]
impl Action for StopCommandAction {
    fn name(&self) -> &str {
        "STOP_COMMAND"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["/stop", "/abort", "/cancel"]
    }

    fn description(&self) -> &str {
        "Stop current operation or abort running tasks. Triggered by /stop, /abort, or /cancel."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if let Some(parsed) = crate::parser::parse_command(text) {
            matches!(parsed.name.as_str(), "stop" | "abort" | "cancel")
        } else {
            false
        }
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        _registry: Option<&CommandRegistry>,
    ) -> ActionResult {
        let room_id = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let entity_id = message
            .get("entity_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        info!(
            room_id = room_id,
            entity_id = entity_id,
            "Stop command received"
        );

        let reply = "Stop requested. Current operations will be cancelled.";

        ActionResult {
            success: true,
            text: reply.to_string(),
            data: Some(serde_json::json!({
                "command": "stop",
                "room_id": room_id,
            })),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "/stop".to_string(),
                agent_response: "Stop requested. Current operations will be cancelled."
                    .to_string(),
            },
            ActionExample {
                user_message: "/abort".to_string(),
                agent_response: "Stop requested. Current operations will be cancelled."
                    .to_string(),
            },
        ]
    }
}
