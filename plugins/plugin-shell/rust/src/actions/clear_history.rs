use crate::{Action, ActionExample, ActionResult, ShellService};
use async_trait::async_trait;
use serde_json::Value;

pub struct ClearHistoryAction;

impl ClearHistoryAction {
    const CLEAR_KEYWORDS: &'static [&'static str] =
        &["clear", "reset", "delete", "remove", "clean"];
    const HISTORY_KEYWORDS: &'static [&'static str] = &["history", "terminal", "shell", "command"];

    fn has_clear_keyword(text: &str) -> bool {
        let lower = text.to_lowercase();
        Self::CLEAR_KEYWORDS.iter().any(|kw| lower.contains(kw))
    }

    fn has_history_keyword(text: &str) -> bool {
        let lower = text.to_lowercase();
        Self::HISTORY_KEYWORDS.iter().any(|kw| lower.contains(kw))
    }
}

#[async_trait]
impl Action for ClearHistoryAction {
    fn name(&self) -> &str {
        "CLEAR_SHELL_HISTORY"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "RESET_SHELL",
            "CLEAR_TERMINAL",
            "CLEAR_HISTORY",
            "RESET_HISTORY",
        ]
    }

    fn description(&self) -> &str {
        "Clears the recorded history of shell commands for the current conversation"
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        Self::has_clear_keyword(text) && Self::has_history_keyword(text)
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut ShellService>,
    ) -> ActionResult {
        let service = match service {
            Some(s) => s,
            None => {
                return ActionResult {
                    success: false,
                    text: "Shell service is not available.".to_string(),
                    data: None,
                    error: Some("Shell service is not available".to_string()),
                }
            }
        };

        let conversation_id = message
            .get("room_id")
            .and_then(|r| r.as_str())
            .or_else(|| message.get("agent_id").and_then(|a| a.as_str()))
            .unwrap_or("default");

        service.clear_command_history(conversation_id);

        ActionResult {
            success: true,
            text: "Shell command history has been cleared.".to_string(),
            data: None,
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "clear my shell history".to_string(),
                agent_response: "Shell command history has been cleared.".to_string(),
            },
            ActionExample {
                user_message: "reset the terminal history".to_string(),
                agent_response: "Shell command history has been cleared.".to_string(),
            },
            ActionExample {
                user_message: "delete command history".to_string(),
                agent_response: "Shell command history has been cleared.".to_string(),
            },
        ]
    }
}
