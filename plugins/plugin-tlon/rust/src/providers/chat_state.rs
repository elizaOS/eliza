//! Chat state provider.

use async_trait::async_trait;
use serde_json::Value;

use super::{ProviderContext, TlonProvider};
use crate::types::TlonChannelType;

/// Provider that exposes the current chat/ship/channel context as JSON.
pub struct ChatStateProvider;

#[async_trait]
impl TlonProvider for ChatStateProvider {
    fn name(&self) -> &'static str {
        "tlon_chat_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        let chat_type = if context.channel_nest.is_some() {
            if context.reply_to_id.is_some() {
                TlonChannelType::Thread
            } else {
                TlonChannelType::Group
            }
        } else {
            TlonChannelType::Dm
        };

        let is_dm = chat_type == TlonChannelType::Dm;
        let is_group = chat_type == TlonChannelType::Group;
        let is_thread = chat_type == TlonChannelType::Thread;

        serde_json::json!({
            "ship": context.ship,
            "channel_nest": context.channel_nest,
            "reply_to_id": context.reply_to_id,
            "room_id": context.room_id,
            "chat_type": chat_type.to_string(),
            "is_dm": is_dm,
            "is_group": is_group,
            "is_thread": is_thread
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_chat_state_dm() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            ship: Some("sampel-palnet".to_string()),
            channel_nest: None,
            reply_to_id: None,
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["ship"], "sampel-palnet");
        assert_eq!(state["chat_type"], "dm");
        assert_eq!(state["is_dm"], true);
        assert_eq!(state["is_group"], false);
    }

    #[tokio::test]
    async fn test_chat_state_group() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            ship: Some("sampel-palnet".to_string()),
            channel_nest: Some("chat/~host/channel".to_string()),
            reply_to_id: None,
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["channel_nest"], "chat/~host/channel");
        assert_eq!(state["chat_type"], "group");
        assert_eq!(state["is_dm"], false);
        assert_eq!(state["is_group"], true);
    }

    #[tokio::test]
    async fn test_chat_state_thread() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            ship: Some("sampel-palnet".to_string()),
            channel_nest: Some("chat/~host/channel".to_string()),
            reply_to_id: Some("parent-id".to_string()),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["chat_type"], "thread");
        assert_eq!(state["is_thread"], true);
        assert_eq!(state["reply_to_id"], "parent-id");
    }
}
