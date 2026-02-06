//! Chat context provider for iMessage

use crate::service::IMessageService;
use crate::IMESSAGE_SERVICE_NAME;
use async_trait::async_trait;
use elizaos::{IAgentRuntime, Memory, Provider, State};
use tracing::debug;

/// Provider that supplies iMessage chat context
pub struct ChatContextProvider;

impl ChatContextProvider {
    /// Creates a new chat context provider
    pub fn new() -> Self {
        Self
    }
}

impl Default for ChatContextProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Provider for ChatContextProvider {
    fn name(&self) -> &str {
        "IMESSAGE_CHAT_CONTEXT"
    }

    fn description(&self) -> &str {
        "Provides information about the current iMessage chat context"
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> String {
        let service = match runtime.get_service::<IMessageService>(IMESSAGE_SERVICE_NAME) {
            Some(s) => s,
            None => return String::new(),
        };

        let room = match runtime.get_room(&message.room_id).await {
            Ok(Some(r)) => r,
            _ => return String::new(),
        };

        // Only provide context for iMessage channels
        if room.source.as_deref() != Some("imessage") {
            return String::new();
        }

        let channel_id = match room.channel_id {
            Some(ref id) => id,
            None => return String::new(),
        };

        format_chat_context(channel_id, room.name.as_deref())
    }
}

fn format_chat_context(channel_id: &str, name: Option<&str>) -> String {
    let mut lines = vec![
        "# iMessage Chat Context".to_string(),
        String::new(),
    ];

    if let Some(chat_name) = name {
        lines.push(format!("- Chat: {}", chat_name));
    }

    lines.push(format!("- Channel ID: {}", channel_id));
    lines.push(String::new());
    lines.push(
        "Note: This conversation is happening through iMessage. Be conversational and friendly."
            .to_string(),
    );

    lines.join("\n")
}
