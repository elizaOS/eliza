use async_trait::async_trait;
use serde_json::Value;

use super::{NextcloudTalkProvider, ProviderContext};

/// Provider that exposes the current chat/room/user context as JSON.
pub struct ChatStateProvider;

#[async_trait]
impl NextcloudTalkProvider for ChatStateProvider {
    fn name(&self) -> &'static str {
        "nextcloud_talk_chat_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        let is_group = context.is_group_chat.unwrap_or(false);
        let is_private = context.is_group_chat.map(|g| !g).unwrap_or(false);

        serde_json::json!({
            "room_token": context.room_token,
            "user_id": context.user_id,
            "room_name": context.room_name,
            "room_id": context.room_id,
            "is_group_chat": is_group,
            "is_private": is_private
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_chat_state_group() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            room_token: Some("abc123".to_string()),
            user_id: Some("user1".to_string()),
            room_name: Some("Test Group".to_string()),
            room_id: Some("room-uuid".to_string()),
            is_group_chat: Some(true),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["room_token"], "abc123");
        assert_eq!(state["is_group_chat"], true);
        assert_eq!(state["is_private"], false);
    }

    #[tokio::test]
    async fn test_chat_state_private() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            room_token: Some("xyz789".to_string()),
            user_id: Some("user2".to_string()),
            room_name: Some("John Doe".to_string()),
            room_id: Some("room-uuid".to_string()),
            is_group_chat: Some(false),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["room_token"], "xyz789");
        assert_eq!(state["is_group_chat"], false);
        assert_eq!(state["is_private"], true);
    }
}
