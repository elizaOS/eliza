//! Chat state provider for Zalo User.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Provider name constant.
pub const CHAT_STATE_PROVIDER: &str = "zalouser_chat_state";

/// Provider description.
pub const CHAT_STATE_DESCRIPTION: &str =
    "Provides Zalo User chat context including thread ID, user ID, and chat type";

/// Chat state data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatStateData {
    /// Thread/conversation ID.
    pub thread_id: Option<String>,
    /// User ID.
    pub user_id: Option<String>,
    /// Sender ID.
    pub sender_id: Option<String>,
    /// Room ID.
    pub room_id: Option<String>,
    /// Whether this is a private chat.
    pub is_private: bool,
    /// Whether this is a group chat.
    pub is_group: bool,
}

/// Chat state result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStateResult {
    /// Structured data.
    pub data: ChatStateData,
    /// String values for templates.
    pub values: HashMap<String, String>,
    /// Human-readable text.
    pub text: String,
}

/// Get chat state from message context.
pub fn get_chat_state(
    thread_id: Option<&str>,
    user_id: Option<&str>,
    sender_id: Option<&str>,
    room_id: Option<&str>,
    is_group: Option<bool>,
) -> ChatStateResult {
    let is_group = is_group.unwrap_or(false);
    let is_private = !is_group;

    let data = ChatStateData {
        thread_id: thread_id.map(|s| s.to_string()),
        user_id: user_id.map(|s| s.to_string()),
        sender_id: sender_id.map(|s| s.to_string()),
        room_id: room_id.map(|s| s.to_string()),
        is_private,
        is_group,
    };

    let mut values = HashMap::new();
    values.insert("thread_id".to_string(), thread_id.unwrap_or("").to_string());
    values.insert("user_id".to_string(), user_id.unwrap_or("").to_string());
    values.insert("sender_id".to_string(), sender_id.unwrap_or("").to_string());
    values.insert("room_id".to_string(), room_id.unwrap_or("").to_string());
    values.insert("is_private".to_string(), is_private.to_string());
    values.insert("is_group".to_string(), is_group.to_string());

    let mut text = "Zalo User Chat State:\n".to_string();
    if let Some(tid) = thread_id {
        text.push_str(&format!("Thread ID: {}\n", tid));
        text.push_str(&format!("Chat Type: {}\n", if is_group { "Group" } else { "Private" }));
    }
    if let Some(uid) = user_id {
        text.push_str(&format!("User ID: {}\n", uid));
    }
    if let Some(sid) = sender_id {
        text.push_str(&format!("Sender ID: {}\n", sid));
    }

    ChatStateResult { data, values, text }
}

/// Provider metadata for registration.
#[derive(Debug, Clone, Serialize)]
pub struct ChatStateProviderMeta {
    /// The provider name.
    pub name: &'static str,
    /// Description of the provider.
    pub description: &'static str,
    /// Whether the provider is dynamic.
    pub dynamic: bool,
}

impl Default for ChatStateProviderMeta {
    fn default() -> Self {
        Self {
            name: CHAT_STATE_PROVIDER,
            description: CHAT_STATE_DESCRIPTION,
            dynamic: true,
        }
    }
}

/// Get provider metadata.
pub fn chat_state_provider_meta() -> ChatStateProviderMeta {
    ChatStateProviderMeta::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_chat_state_private() {
        let result = get_chat_state(
            Some("123"),
            Some("user1"),
            Some("sender1"),
            Some("room1"),
            Some(false),
        );

        assert!(result.data.is_private);
        assert!(!result.data.is_group);
        assert_eq!(result.data.thread_id, Some("123".to_string()));
        assert!(result.text.contains("Private"));
    }

    #[test]
    fn test_get_chat_state_group() {
        let result = get_chat_state(
            Some("456"),
            None,
            Some("sender2"),
            None,
            Some(true),
        );

        assert!(!result.data.is_private);
        assert!(result.data.is_group);
        assert!(result.text.contains("Group"));
    }

    #[test]
    fn test_provider_meta() {
        let meta = chat_state_provider_meta();
        assert_eq!(meta.name, CHAT_STATE_PROVIDER);
        assert!(meta.dynamic);
    }
}
