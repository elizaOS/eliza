//! Chat state provider implementation.

use async_trait::async_trait;
use serde_json::Value;

use super::{ProviderContext, ZaloProvider};

/// Provider that exposes the current chat/user context as JSON.
pub struct ChatStateProvider;

#[async_trait]
impl ZaloProvider for ChatStateProvider {
    fn name(&self) -> &'static str {
        "zalo_chat_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        serde_json::json!({
            "user_id": context.user_id,
            "chat_id": context.user_id,  // Same as user_id for Zalo OA
            "room_id": context.room_id,
            "is_private": true,  // Zalo OA only supports DMs
            "platform": "zalo"
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_chat_state() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            user_id: Some("12345".to_string()),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["user_id"], "12345");
        assert_eq!(state["is_private"], true);
        assert_eq!(state["platform"], "zalo");
    }

    #[tokio::test]
    async fn test_chat_state_empty() {
        let provider = ChatStateProvider;
        let context = ProviderContext::default();

        let state = provider.get(&context).await;
        assert!(state["user_id"].is_null());
        assert_eq!(state["is_private"], true);
    }
}
