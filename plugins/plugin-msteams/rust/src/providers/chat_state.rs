//! Chat state providers for MS Teams.

use async_trait::async_trait;
use serde_json::Value;

use super::{MSTeamsProvider, ProviderContext};

/// Provider that exposes the current conversation/user/tenant context as JSON.
pub struct ChatStateProvider;

#[async_trait]
impl MSTeamsProvider for ChatStateProvider {
    fn name(&self) -> &'static str {
        "msteams_chat_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        let is_personal = context
            .conversation_type
            .as_ref()
            .map(|t| t == "personal")
            .unwrap_or(false);
        let is_group_chat = context
            .conversation_type
            .as_ref()
            .map(|t| t == "groupChat")
            .unwrap_or(false);
        let is_channel = context
            .conversation_type
            .as_ref()
            .map(|t| t == "channel")
            .unwrap_or(false);

        serde_json::json!({
            "conversationId": context.conversation_id,
            "userId": context.user_id,
            "tenantId": context.tenant_id,
            "conversationType": context.conversation_type,
            "activityId": context.activity_id,
            "roomId": context.room_id,
            "isPersonal": is_personal,
            "isGroupChat": is_group_chat,
            "isChannel": is_channel
        })
    }
}

/// Provider that exposes information about conversation members.
pub struct ConversationMembersProvider;

#[async_trait]
impl MSTeamsProvider for ConversationMembersProvider {
    fn name(&self) -> &'static str {
        "msteams_conversation_members"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        // In a real implementation, this would fetch members from the service
        serde_json::json!({
            "conversationId": context.conversation_id,
            "members": [],
            "memberCount": 0
        })
    }
}

/// Provider that exposes team and channel information.
pub struct TeamInfoProvider;

#[async_trait]
impl MSTeamsProvider for TeamInfoProvider {
    fn name(&self) -> &'static str {
        "msteams_team_info"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        let is_channel = context
            .conversation_type
            .as_ref()
            .map(|t| t == "channel")
            .unwrap_or(false);

        serde_json::json!({
            "conversationId": context.conversation_id,
            "tenantId": context.tenant_id,
            "isChannel": is_channel,
            "teamId": null,
            "teamName": null,
            "channelId": if is_channel { context.conversation_id.clone() } else { None },
            "channelName": null
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_chat_state_personal() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            conversation_id: Some("conv-123".to_string()),
            user_id: Some("user-456".to_string()),
            tenant_id: Some("tenant-789".to_string()),
            conversation_type: Some("personal".to_string()),
            activity_id: Some("activity-abc".to_string()),
            room_id: Some("room-xyz".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["conversationId"], "conv-123");
        assert_eq!(state["isPersonal"], true);
        assert_eq!(state["isGroupChat"], false);
        assert_eq!(state["isChannel"], false);
    }

    #[tokio::test]
    async fn test_chat_state_group_chat() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            conversation_id: Some("conv-123".to_string()),
            user_id: Some("user-456".to_string()),
            tenant_id: Some("tenant-789".to_string()),
            conversation_type: Some("groupChat".to_string()),
            activity_id: None,
            room_id: None,
        };

        let state = provider.get(&context).await;
        assert_eq!(state["isPersonal"], false);
        assert_eq!(state["isGroupChat"], true);
        assert_eq!(state["isChannel"], false);
    }

    #[tokio::test]
    async fn test_chat_state_channel() {
        let provider = ChatStateProvider;
        let context = ProviderContext {
            conversation_id: Some("19:abc@thread.tacv2".to_string()),
            user_id: Some("user-456".to_string()),
            tenant_id: Some("tenant-789".to_string()),
            conversation_type: Some("channel".to_string()),
            activity_id: None,
            room_id: None,
        };

        let state = provider.get(&context).await;
        assert_eq!(state["isPersonal"], false);
        assert_eq!(state["isGroupChat"], false);
        assert_eq!(state["isChannel"], true);
    }

    #[tokio::test]
    async fn test_team_info_provider() {
        let provider = TeamInfoProvider;
        let context = ProviderContext {
            conversation_id: Some("19:abc@thread.tacv2".to_string()),
            user_id: None,
            tenant_id: Some("tenant-789".to_string()),
            conversation_type: Some("channel".to_string()),
            activity_id: None,
            room_id: None,
        };

        let info = provider.get(&context).await;
        assert_eq!(info["isChannel"], true);
        assert_eq!(info["tenantId"], "tenant-789");
    }
}
