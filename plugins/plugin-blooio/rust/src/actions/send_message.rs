use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;

use crate::constants::error_messages;
use crate::service::BlooioService;
use crate::types::MessageTarget;
use crate::utils::{extract_urls, validate_chat_id};
use crate::{Action, ActionExample, ActionResult};

/// Action that sends a message via Blooio to a phone, email, or group.
pub struct SendMessageAction;

#[async_trait]
impl Action for SendMessageAction {
    fn name(&self) -> &str {
        "SEND_MESSAGE"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["SEND_TEXT", "SEND_IMESSAGE", "MESSAGE", "TEXT"]
    }

    fn description(&self) -> &str {
        "Send a message via Blooio to a chat (phone, email, or group)"
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .pointer("/content/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        extract_chat_id_candidates(text)
            .iter()
            .any(|c| validate_chat_id(c))
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut BlooioService>,
    ) -> ActionResult {
        let Some(svc) = service else {
            return ActionResult {
                success: false,
                text: error_messages::SERVICE_NOT_AVAILABLE.to_string(),
                data: None,
                error: Some("missing_service".to_string()),
            };
        };

        let text = message
            .pointer("/content/text")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let candidates = extract_chat_id_candidates(text);
        let valid: Vec<&str> = candidates
            .iter()
            .filter(|c| validate_chat_id(c))
            .map(|s| s.as_str())
            .collect();

        if valid.is_empty() {
            return ActionResult {
                success: false,
                text: error_messages::NO_VALID_RECIPIENT.to_string(),
                data: None,
                error: Some("no_recipient".to_string()),
            };
        }

        // Use the first valid identifier as the target.
        let chat_id_str = valid[0];
        let target = match MessageTarget::from_str(chat_id_str) {
            Some(t) => t,
            None => {
                return ActionResult {
                    success: false,
                    text: error_messages::INVALID_CHAT_ID.to_string(),
                    data: None,
                    error: Some("invalid_target".to_string()),
                };
            }
        };

        // Strip chat IDs and URLs from the text to get the message body.
        let mut content = text.to_string();
        for id in &valid {
            content = content.replace(id, "");
        }
        let urls = extract_urls(&content);
        for url in &urls {
            content = content.replace(url.as_str(), "");
        }
        // Remove common command phrases.
        let cmd_re =
            Regex::new(r"(?i)send\s+(a\s+)?(message|text|imessage|sms)?\s*(to)?\s*").unwrap();
        content = cmd_re.replace_all(&content, "").to_string();
        content = content.trim().to_string();
        if content.is_empty() {
            content = "Hello from your assistant.".to_string();
        }

        match svc.send_message(&target, &content, &urls).await {
            Ok(resp) => ActionResult {
                success: true,
                text: format!("Message sent successfully to {}", chat_id_str),
                data: serde_json::to_value(&resp).ok(),
                error: None,
            },
            Err(e) => ActionResult {
                success: false,
                text: format!("Failed to send message: {}", e),
                data: None,
                error: Some(e.to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "Send a message to +17147023671 saying 'Hello from Blooio!'"
                    .to_string(),
                agent_response: "I'll send that message.".to_string(),
            },
            ActionExample {
                user_message: "Message jane@example.com with 'Your iMessage is ready.'"
                    .to_string(),
                agent_response: "Sending that now.".to_string(),
            },
        ]
    }
}

/// Extract candidate chat identifiers (phones, group IDs, emails) from free text.
fn extract_chat_id_candidates(text: &str) -> Vec<String> {
    let mut matches: Vec<(usize, String)> = Vec::new();

    let phone_re = Regex::new(r"\+\d{1,15}").unwrap();
    for m in phone_re.find_iter(text) {
        matches.push((m.start(), m.as_str().to_string()));
    }

    let group_re = Regex::new(r"\bgrp_[A-Za-z0-9]+\b").unwrap();
    for m in group_re.find_iter(text) {
        matches.push((m.start(), m.as_str().to_string()));
    }

    let email_re = Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").unwrap();
    for m in email_re.find_iter(text) {
        matches.push((m.start(), m.as_str().to_string()));
    }

    matches.sort_by_key(|(idx, _)| *idx);

    let mut unique: Vec<String> = Vec::new();
    for (_, val) in matches {
        if !unique.contains(&val) {
            unique.push(val);
        }
    }
    unique
}
