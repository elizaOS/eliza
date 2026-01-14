//! User state provider for Instagram

use async_trait::async_trait;
use serde_json::Value;

use super::{InstagramProvider, ProviderContext};

/// Provider for Instagram user state
pub struct UserStateProvider;

#[async_trait]
impl InstagramProvider for UserStateProvider {
    fn name(&self) -> &'static str {
        "instagram_user_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        serde_json::json!({
            "user_id": context.user_id,
            "thread_id": context.thread_id,
            "media_id": context.media_id,
            "room_id": context.room_id,
            "is_dm": context.thread_id.is_some(),
            "is_comment": context.media_id.is_some()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_user_state_dm() {
        let provider = UserStateProvider;
        let context = ProviderContext {
            user_id: Some(12345),
            thread_id: Some("thread-1".to_string()),
            media_id: None,
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["user_id"], 12345);
        assert_eq!(state["is_dm"], true);
        assert_eq!(state["is_comment"], false);
    }

    #[tokio::test]
    async fn test_user_state_comment() {
        let provider = UserStateProvider;
        let context = ProviderContext {
            user_id: Some(12345),
            thread_id: None,
            media_id: Some(67890),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["user_id"], 12345);
        assert_eq!(state["is_dm"], false);
        assert_eq!(state["is_comment"], true);
    }
}
