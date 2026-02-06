use async_trait::async_trait;
use serde_json::Value;

use super::{MattermostProvider, ProviderContext};
use crate::types::MattermostChannelType;

/// Provider that exposes the current chat/channel context as JSON.
pub struct ChatStateProvider;

#[async_trait]
impl MattermostProvider for ChatStateProvider {
    fn name(&self) -> &'static str {
        "mattermost_chat_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        let channel_type = context
            .channel_type
            .as_ref()
            .and_then(|t| MattermostChannelType::from_str(t));

        let is_dm = channel_type
            .map(|t| matches!(t, MattermostChannelType::Direct))
            .unwrap_or(false);
        let is_group = channel_type
            .map(|t| matches!(t, MattermostChannelType::Group))
            .unwrap_or(false);
        let is_channel = channel_type
            .map(|t| {
                matches!(
                    t,
                    MattermostChannelType::Open | MattermostChannelType::Private
                )
            })
            .unwrap_or(false);
        let is_thread = context.root_id.is_some();

        serde_json::json!({
            "channel_id": context.channel_id,
            "user_id": context.user_id,
            "post_id": context.post_id,
            "root_id": context.root_id,
            "team_id": context.team_id,
            "channel_type": context.channel_type,
            "room_id": context.room_id,
            "is_dm": is_dm,
            "is_group": is_group,
            "is_channel": is_channel,
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
            channel_id: Some("channel123".to_string()),
            user_id: Some("user456".to_string()),
            post_id: Some("post789".to_string()),
            root_id: None,
            team_id: Some("team111".to_string()),
            channel_type: Some("D".to_string()),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["channel_id"], "channel123");
        assert_eq!(state["is_dm"], true);
        assert_eq!(state["is_group"], false);
        assert_eq!(state["is_thread"], false);
    }

    #[tokio::test]
    async fn test_chat_state_thread() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            channel_id: Some("channel123".to_string()),
            user_id: Some("user456".to_string()),
            post_id: Some("post789".to_string()),
            root_id: Some("root111".to_string()),
            team_id: Some("team111".to_string()),
            channel_type: Some("O".to_string()),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["is_dm"], false);
        assert_eq!(state["is_channel"], true);
        assert_eq!(state["is_thread"], true);
    }
}
