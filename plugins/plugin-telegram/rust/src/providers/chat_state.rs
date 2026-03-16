use async_trait::async_trait;
use serde_json::Value;

use super::{ProviderContext, TelegramProvider};

/// Provider that exposes the current chat/user/thread context as JSON.
pub struct ChatStateProvider;

#[async_trait]
impl TelegramProvider for ChatStateProvider {
    fn name(&self) -> &'static str {
        "telegram_chat_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        serde_json::json!({
            "chat_id": context.chat_id,
            "user_id": context.user_id,
            "thread_id": context.thread_id,
            "room_id": context.room_id,
            "is_private": context.chat_id.map(|id| id > 0).unwrap_or(false),
            "is_group": context.chat_id.map(|id| id < 0).unwrap_or(false)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_chat_state_private() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            chat_id: Some(12345),
            user_id: Some(12345),
            thread_id: None,
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["chat_id"], 12345);
        assert_eq!(state["is_private"], true);
        assert_eq!(state["is_group"], false);
    }

    #[tokio::test]
    async fn test_chat_state_group() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            chat_id: Some(-12345),
            user_id: Some(67890),
            thread_id: Some(1),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["chat_id"], -12345);
        assert_eq!(state["is_private"], false);
        assert_eq!(state["is_group"], true);
    }
}
