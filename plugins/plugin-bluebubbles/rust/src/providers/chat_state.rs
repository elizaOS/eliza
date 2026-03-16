//! Chat state provider for BlueBubbles

use crate::service::BlueBubblesService;
use crate::types::BlueBubblesChatState;
use crate::BLUEBUBBLES_SERVICE_NAME;
use async_trait::async_trait;
use elizaos::{IAgentRuntime, Memory, Provider, State};
use tracing::debug;

/// Provider that supplies BlueBubbles chat context
pub struct ChatStateProvider;

impl ChatStateProvider {
    /// Creates a new chat state provider
    pub fn new() -> Self {
        Self
    }
}

impl Default for ChatStateProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Provider for ChatStateProvider {
    fn name(&self) -> &str {
        "BLUEBUBBLES_CHAT_STATE"
    }

    fn description(&self) -> &str {
        "Provides information about the current BlueBubbles/iMessage chat context"
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> String {
        let service = match runtime.get_service::<BlueBubblesService>(BLUEBUBBLES_SERVICE_NAME) {
            Some(s) => s,
            None => return String::new(),
        };

        let room = match runtime.get_room(&message.room_id).await {
            Ok(Some(r)) => r,
            _ => return String::new(),
        };

        // Only provide state for BlueBubbles channels
        if room.source.as_deref() != Some("bluebubbles") {
            return String::new();
        }

        let channel_id = match room.channel_id {
            Some(ref id) => id,
            None => return String::new(),
        };

        let chat_state = match service.get_chat_state(channel_id).await {
            Ok(Some(state)) => state,
            _ => return String::new(),
        };

        format_chat_state(&chat_state)
    }
}

/// Formats the chat state for inclusion in prompts
fn format_chat_state(state: &BlueBubblesChatState) -> String {
    let mut lines = vec![
        "# iMessage Chat Context (BlueBubbles)".to_string(),
        String::new(),
        format!(
            "- Chat Type: {}",
            if state.is_group {
                "Group Chat"
            } else {
                "Direct Message"
            }
        ),
    ];

    if let Some(ref name) = state.display_name {
        lines.push(format!("- Chat Name: {}", name));
    }

    if state.is_group {
        lines.push(format!("- Participants: {}", state.participants.join(", ")));
    } else {
        lines.push(format!(
            "- Contact: {}",
            state
                .participants
                .first()
                .unwrap_or(&state.chat_identifier)
        ));
    }

    if let Some(timestamp) = state.last_message_at {
        // Format timestamp - in production use chrono for proper formatting
        lines.push(format!("- Last Message: {} (timestamp)", timestamp));
    }

    if state.has_unread {
        lines.push("- Has Unread Messages: Yes".to_string());
    }

    lines.push(String::new());
    lines.push(
        "Note: This conversation is happening through iMessage. Be conversational and friendly."
            .to_string(),
    );

    lines.join("\n")
}
