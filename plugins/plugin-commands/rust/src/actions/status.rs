use async_trait::async_trait;
use serde_json::Value;

use crate::registry::CommandRegistry;
use crate::{Action, ActionExample, ActionResult};

pub struct StatusCommandAction;

#[async_trait]
impl Action for StatusCommandAction {
    fn name(&self) -> &str {
        "STATUS_COMMAND"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["/status", "/s"]
    }

    fn description(&self) -> &str {
        "Show current session status. Only activates for /status or /s slash commands."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if let Some(parsed) = crate::parser::parse_command(text) {
            matches!(parsed.name.as_str(), "status" | "s")
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
        let agent_id = message
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let room_id = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let mut lines = vec![
            "**Session Status:**".to_string(),
            String::new(),
            format!("**Agent:** {}", agent_id),
            format!("**Room:** {}", room_id),
        ];

        // Include runtime uptime hint if available in state
        lines.push(String::new());
        lines.push("**Status:** Active".to_string());

        let text = lines.join("\n");
        ActionResult {
            success: true,
            text,
            data: Some(serde_json::json!({
                "agent_id": agent_id,
                "room_id": room_id,
                "status": "active",
            })),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "/status".to_string(),
            agent_response: "**Session Status:**\n\n**Agent:** eliza\n**Room:** room-456\n\n**Status:** Active".to_string(),
        }]
    }
}
