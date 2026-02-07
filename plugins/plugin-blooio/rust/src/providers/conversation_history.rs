use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};

use crate::service::BlooioService;
use crate::{Provider, ProviderResult};

/// Provider that exposes recent Blooio conversation history to the runtime.
pub struct ConversationHistoryProvider;

#[async_trait]
impl Provider for ConversationHistoryProvider {
    fn name(&self) -> &str {
        "CONVERSATION_HISTORY"
    }

    fn description(&self) -> &str {
        "Provides recent Blooio conversation history with a chat"
    }

    fn position(&self) -> i32 {
        90
    }

    async fn get(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&BlooioService>,
    ) -> ProviderResult {
        let Some(svc) = service else {
            return ProviderResult {
                values: json!({ "conversationHistory": "Service not available" }),
                text: "No Blooio conversation history available - service not initialized"
                    .to_string(),
                data: json!({ "messageCount": 0 }),
            };
        };

        // Try to find a chat identifier from multiple sources.
        let chat_id = message
            .pointer("/content/chatId")
            .and_then(|v| v.as_str())
            .or_else(|| {
                message
                    .pointer("/content/phoneNumber")
                    .and_then(|v| v.as_str())
            })
            .or_else(|| {
                message
                    .pointer("/content/text")
                    .and_then(|v| v.as_str())
                    .and_then(|text| {
                        let re = Regex::new(
                            r"(\+\d{1,15}|grp_[A-Za-z0-9]+|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})",
                        )
                        .ok()?;
                        re.find(text).map(|m| m.as_str())
                    })
            });

        let Some(chat_id) = chat_id else {
            return ProviderResult {
                values: json!({ "conversationHistory": "No chat identifier found" }),
                text: "No chat identifier found in context".to_string(),
                data: json!({ "messageCount": 0 }),
            };
        };

        let history = svc.get_conversation_history(chat_id, 10);

        if history.is_empty() {
            return ProviderResult {
                values: json!({
                    "conversationHistory": format!("No recent history with {}", chat_id)
                }),
                text: format!("No recent conversation history with {}", chat_id),
                data: json!({ "chatId": chat_id, "messageCount": 0 }),
            };
        }

        let formatted: Vec<String> = history
            .iter()
            .map(|entry| format!("[{}] {}: {}", entry.timestamp, entry.role, entry.text))
            .collect();

        let history_text = formatted.join("\n");
        let count = history.len();

        ProviderResult {
            values: json!({
                "conversationHistory": history_text,
                "chatId": chat_id
            }),
            text: format!(
                "Recent Blooio conversation with {}:\n{}",
                chat_id, history_text
            ),
            data: json!({
                "chatId": chat_id,
                "messageCount": count,
                "lastMessage": history.last().map(|e| json!({
                    "role": e.role,
                    "text": e.text,
                    "timestamp": e.timestamp
                }))
            }),
        }
    }
}
