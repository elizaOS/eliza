use async_trait::async_trait;
use serde_json::Value;

use crate::service::CoderService;
use crate::{Action, ActionExample, ActionResult};

pub struct SearchFilesAction;

#[async_trait]
impl Action for SearchFilesAction {
    fn name(&self) -> &str {
        "SEARCH_FILES"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["GREP", "RG", "FIND_IN_FILES", "SEARCH"]
    }

    fn description(&self) -> &str {
        "Search for text across files under a directory."
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

        let pattern = state
            .get("pattern")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let dirpath = state
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or(".")
            .to_string();
        let max_matches = state
            .get("max_matches")
            .and_then(|v| v.as_u64())
            .unwrap_or(50) as usize;
        if pattern.trim().is_empty() {
            return ActionResult {
                success: false,
                text: "Missing pattern.".to_string(),
                data: None,
                error: Some("missing_pattern".to_string()),
            };
        }

        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        match svc
            .search_files(conv, &pattern, &dirpath, max_matches)
            .await
        {
            Ok(matches) => {
                let text = if matches.is_empty() {
                    format!("No matches for \"{}\".", pattern)
                } else {
                    matches
                        .iter()
                        .map(|(f, l, c)| format!("{}:L{}: {}", f, l, c))
                        .collect::<Vec<String>>()
                        .join("\n")
                };
                ActionResult {
                    success: true,
                    text,
                    data: None,
                    error: None,
                }
            }
            Err(err) => ActionResult {
                success: false,
                text: err,
                data: None,
                error: Some("search_failed".to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![ActionExample {
            user_message: "search files".to_string(),
            agent_response: "Searching…".to_string(),
        }]
    }
}
