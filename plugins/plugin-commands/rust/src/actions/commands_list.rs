use async_trait::async_trait;
use serde_json::Value;

use crate::registry::CommandRegistry;
use crate::{Action, ActionExample, ActionResult};

pub struct CommandsListAction;

#[async_trait]
impl Action for CommandsListAction {
    fn name(&self) -> &str {
        "COMMANDS_LIST_COMMAND"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["/commands", "/cmds"]
    }

    fn description(&self) -> &str {
        "List all registered commands with their aliases. Only activates for /commands or /cmds."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if let Some(parsed) = crate::parser::parse_command(text) {
            matches!(parsed.name.as_str(), "commands" | "cmds")
        } else {
            false
        }
    }

    async fn handler(
        &self,
        _message: &Value,
        _state: &Value,
        registry: Option<&CommandRegistry>,
    ) -> ActionResult {
        let Some(reg) = registry else {
            return ActionResult {
                success: false,
                text: "Command registry is not available.".to_string(),
                data: None,
                error: Some("missing_registry".to_string()),
            };
        };

        let all = reg.list_all();
        let count = all.len();
        let mut lines = vec![format!("**Commands ({}):**", count), String::new()];

        for cmd in &all {
            let aliases = if cmd.aliases.is_empty() {
                format!("/{}", cmd.name)
            } else {
                let alias_strs: Vec<String> =
                    cmd.aliases.iter().map(|a| format!("/{}", a)).collect();
                format!("/{}, {}", cmd.name, alias_strs.join(", "))
            };
            let hidden_note = if cmd.hidden { " [hidden]" } else { "" };
            lines.push(format!(
                "  **{}**: {}{}",
                cmd.name, aliases, hidden_note
            ));
        }

        let text = lines.join("\n");
        ActionResult {
            success: true,
            text,
            data: Some(serde_json::json!({ "commandCount": count })),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "/commands".to_string(),
            agent_response: "**Commands (5):**\n\n  **help**: /help, /h, /?...\n  **status**: /status, /s...".to_string(),
        }]
    }
}
