use async_trait::async_trait;
use serde_json::Value;

use crate::registry::CommandRegistry;
use crate::{Action, ActionExample, ActionResult};

pub struct HelpCommandAction;

#[async_trait]
impl Action for HelpCommandAction {
    fn name(&self) -> &str {
        "HELP_COMMAND"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["/help", "/h", "/?"]
    }

    fn description(&self) -> &str {
        "Show available commands and their descriptions. Only activates for /help, /h, or /? slash commands."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if let Some(parsed) = crate::parser::parse_command(text) {
            matches!(parsed.name.as_str(), "help" | "h")
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

        let help_text = reg.get_help_text();
        let count = reg.list_all().iter().filter(|c| !c.hidden).count();

        ActionResult {
            success: true,
            text: help_text,
            data: Some(serde_json::json!({ "commandCount": count })),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "/help".to_string(),
                agent_response: "**Available Commands:**\n\n**General:**\n  /help (h, ?) - Show available commands...".to_string(),
            },
            ActionExample {
                user_message: "/?".to_string(),
                agent_response: "**Available Commands:**\n\n**General:**\n  /help (h, ?) - Show available commands...".to_string(),
            },
        ]
    }
}
