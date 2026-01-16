//! RECENT_MESSAGES provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("RECENT_MESSAGES"));

/// Provider for recent message history.
pub struct RecentMessagesProvider;

#[async_trait]
impl Provider for RecentMessagesProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(true)
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let Some(room_id) = message.room_id else {
            return Ok(ProviderResult::new("")
                .with_value("messageCount", 0)
                .with_value("hasHistory", false)
                .with_data("messages", Vec::<serde_json::Value>::new()));
        };

        let mut sections = Vec::new();
        let mut message_list: Vec<serde_json::Value> = Vec::new();

        // Get recent messages
        match runtime.get_memories(Some(room_id), None, None, 20).await {
            Ok(messages) => {
                // Reverse for chronological order
                for msg in messages.into_iter().rev() {
                    if msg.content.text.is_empty() {
                        continue;
                    }

                    // Get sender name
                    let sender_name = if let Some(entity_id) = msg.entity_id {
                        if entity_id == runtime.agent_id() {
                            runtime.character().name.clone()
                        } else if let Ok(Some(entity)) = runtime.get_entity(entity_id).await {
                            entity.name.unwrap_or_else(|| "Unknown".to_string())
                        } else {
                            "Unknown".to_string()
                        }
                    } else {
                        "Unknown".to_string()
                    };

                    let mut message_text = msg.content.text.clone();
                    if message_text.len() > 300 {
                        message_text.truncate(300);
                        message_text.push_str("...");
                    }

                    message_list.push(serde_json::json!({
                        "id": msg.id.to_string(),
                        "sender": sender_name,
                        "text": message_text,
                        "timestamp": msg.created_at.timestamp()
                    }));

                    sections.push(format!("**{}**: {}", sender_name, message_text));
                }
            }
            Err(e) => {
                runtime.log_warning(
                    "provider:recentMessages",
                    &format!("Error fetching messages: {}", e),
                );
            }
        }

        let context_text = if sections.is_empty() {
            String::new()
        } else {
            format!("# Recent Messages\n{}", sections.join("\n"))
        };

        Ok(ProviderResult::new(context_text)
            .with_value("messageCount", message_list.len() as i64)
            .with_value("hasHistory", !message_list.is_empty())
            .with_value("roomId", room_id.to_string())
            .with_data("messages", message_list)
            .with_data("roomId", room_id.to_string()))
    }
}
