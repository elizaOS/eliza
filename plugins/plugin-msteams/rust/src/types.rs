//! Serializable types used for events and payloads.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Event types emitted by the MS Teams plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MSTeamsEventType {
    /// The bot joined a Teams "world" (tenant) context.
    WorldJoined,
    /// The bot connected successfully and is ready to receive messages.
    WorldConnected,
    /// The bot left a Teams "world" (tenant) context.
    WorldLeft,
    /// A user joined a conversation.
    EntityJoined,
    /// A user left a conversation.
    EntityLeft,
    /// A user's membership or profile was updated.
    EntityUpdated,
    /// A message was received.
    MessageReceived,
    /// A message was sent by the bot.
    MessageSent,
    /// A reaction was received.
    ReactionReceived,
    /// A card action (e.g., button click) was received.
    CardActionReceived,
    /// A file consent response was received.
    FileConsentReceived,
}

impl fmt::Display for MSTeamsEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::WorldJoined => "MSTEAMS_WORLD_JOINED",
            Self::WorldConnected => "MSTEAMS_WORLD_CONNECTED",
            Self::WorldLeft => "MSTEAMS_WORLD_LEFT",
            Self::EntityJoined => "MSTEAMS_ENTITY_JOINED",
            Self::EntityLeft => "MSTEAMS_ENTITY_LEFT",
            Self::EntityUpdated => "MSTEAMS_ENTITY_UPDATED",
            Self::MessageReceived => "MSTEAMS_MESSAGE_RECEIVED",
            Self::MessageSent => "MSTEAMS_MESSAGE_SENT",
            Self::ReactionReceived => "MSTEAMS_REACTION_RECEIVED",
            Self::CardActionReceived => "MSTEAMS_CARD_ACTION_RECEIVED",
            Self::FileConsentReceived => "MSTEAMS_FILE_CONSENT_RECEIVED",
        };
        write!(f, "{}", s)
    }
}

/// MS Teams conversation type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationType {
    /// One-on-one personal chat.
    Personal,
    /// Group chat.
    GroupChat,
    /// Team channel.
    Channel,
}

impl fmt::Display for ConversationType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Personal => "personal",
            Self::GroupChat => "groupChat",
            Self::Channel => "channel",
        };
        write!(f, "{}", s)
    }
}

impl Default for ConversationType {
    fn default() -> Self {
        Self::Personal
    }
}

/// MS Teams user information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsUser {
    /// User ID.
    pub id: String,
    /// User display name.
    pub name: Option<String>,
    /// Azure AD Object ID.
    pub aad_object_id: Option<String>,
    /// User email address.
    pub email: Option<String>,
    /// User principal name.
    pub user_principal_name: Option<String>,
}

impl MSTeamsUser {
    /// Returns a human-friendly display name for the user.
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .or_else(|| self.user_principal_name.clone())
            .or_else(|| self.email.clone())
            .unwrap_or_else(|| self.id.clone())
    }
}

/// MS Teams conversation information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsConversation {
    /// Conversation identifier.
    pub id: String,
    /// Conversation type.
    #[serde(rename = "conversationType")]
    pub conversation_type: Option<ConversationType>,
    /// Azure AD Tenant ID.
    #[serde(rename = "tenantId")]
    pub tenant_id: Option<String>,
    /// Conversation name (for groups/channels).
    pub name: Option<String>,
    /// Whether this is a group conversation.
    #[serde(rename = "isGroup")]
    pub is_group: Option<bool>,
}

/// MS Teams channel information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsChannel {
    /// Channel identifier.
    pub id: String,
    /// Channel name.
    pub name: Option<String>,
    /// Azure AD Tenant ID.
    #[serde(rename = "tenantId")]
    pub tenant_id: Option<String>,
}

/// MS Teams team information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsTeam {
    /// Team identifier.
    pub id: String,
    /// Team name.
    pub name: Option<String>,
    /// Azure AD Group ID.
    #[serde(rename = "aadGroupId")]
    pub aad_group_id: Option<String>,
}

/// Stored conversation reference for proactive messaging.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsConversationReference {
    /// Activity ID.
    #[serde(rename = "activityId")]
    pub activity_id: Option<String>,
    /// User information.
    pub user: Option<MSTeamsUser>,
    /// Bot information.
    pub bot: Option<MSTeamsUser>,
    /// Conversation information.
    pub conversation: MSTeamsConversation,
    /// Channel ID (usually "msteams").
    #[serde(rename = "channelId")]
    pub channel_id: String,
    /// Service URL for Bot Framework.
    #[serde(rename = "serviceUrl")]
    pub service_url: Option<String>,
    /// User locale.
    pub locale: Option<String>,
}

/// MS Teams message content extension.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MSTeamsContent {
    /// Text content.
    pub text: Option<String>,
    /// Adaptive Card JSON.
    #[serde(rename = "adaptiveCard")]
    pub adaptive_card: Option<serde_json::Value>,
    /// Message mentions.
    pub mentions: Vec<MSTeamsMention>,
    /// Attachments.
    pub attachments: Vec<MSTeamsAttachment>,
}

/// MS Teams mention.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsMention {
    /// Mentioned user.
    pub mentioned: MSTeamsUser,
    /// Mention text (e.g., "@username").
    pub text: String,
}

/// MS Teams attachment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsAttachment {
    /// Content type.
    #[serde(rename = "contentType")]
    pub content_type: String,
    /// Content URL.
    #[serde(rename = "contentUrl")]
    pub content_url: Option<String>,
    /// Attachment content (for inline content).
    pub content: Option<serde_json::Value>,
    /// Attachment name.
    pub name: Option<String>,
    /// Thumbnail URL.
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: Option<String>,
}

/// MS Teams poll definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsPoll {
    /// Poll identifier.
    pub id: String,
    /// Poll question.
    pub question: String,
    /// Poll options.
    pub options: Vec<String>,
    /// Maximum selections allowed.
    #[serde(rename = "maxSelections")]
    pub max_selections: u32,
    /// Creation timestamp.
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Last update timestamp.
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    /// Conversation ID where the poll was sent.
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
    /// Message ID of the poll.
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    /// Votes by user ID.
    pub votes: std::collections::HashMap<String, Vec<String>>,
}

/// MS Teams poll vote.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsPollVote {
    /// Poll identifier.
    #[serde(rename = "pollId")]
    pub poll_id: String,
    /// Voter identifier.
    #[serde(rename = "voterId")]
    pub voter_id: String,
    /// Selected options (indices).
    pub selections: Vec<String>,
}

/// Payload for a received message event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsMessagePayload {
    /// Activity identifier.
    #[serde(rename = "activityId")]
    pub activity_id: String,
    /// Conversation identifier.
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    /// Conversation type.
    #[serde(rename = "conversationType")]
    pub conversation_type: ConversationType,
    /// Message sender.
    pub from: MSTeamsUser,
    /// Conversation information.
    pub conversation: MSTeamsConversation,
    /// Service URL.
    #[serde(rename = "serviceUrl")]
    pub service_url: String,
    /// Message text.
    pub text: Option<String>,
    /// Message timestamp (seconds since epoch).
    pub timestamp: i64,
    /// Reply-to activity ID.
    #[serde(rename = "replyToId")]
    pub reply_to_id: Option<String>,
    /// Channel-specific data.
    #[serde(rename = "channelData")]
    pub channel_data: Option<serde_json::Value>,
}

/// Payload for a reaction event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsReactionPayload {
    /// Activity identifier.
    #[serde(rename = "activityId")]
    pub activity_id: String,
    /// Conversation identifier.
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    /// User who reacted.
    pub from: MSTeamsUser,
    /// Reaction type (e.g., "like").
    #[serde(rename = "reactionType")]
    pub reaction_type: String,
    /// Message ID that was reacted to.
    #[serde(rename = "messageId")]
    pub message_id: String,
}

/// Payload for a card action event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsCardActionPayload {
    /// Activity identifier.
    #[serde(rename = "activityId")]
    pub activity_id: String,
    /// Conversation identifier.
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    /// User who performed the action.
    pub from: MSTeamsUser,
    /// Action value/data.
    pub value: serde_json::Value,
}

/// MS Teams send message result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsSendResult {
    /// Message identifier.
    #[serde(rename = "messageId")]
    pub message_id: String,
    /// Conversation identifier.
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    /// Activity identifier.
    #[serde(rename = "activityId")]
    pub activity_id: Option<String>,
}

/// MS Teams send message options.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MSTeamsSendOptions {
    /// Reply to a specific message.
    #[serde(rename = "replyToId")]
    pub reply_to_id: Option<String>,
    /// Send as a thread reply.
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
    /// Include an Adaptive Card.
    #[serde(rename = "adaptiveCard")]
    pub adaptive_card: Option<serde_json::Value>,
    /// Include mentions.
    pub mentions: Vec<MSTeamsMention>,
    /// Include media attachments.
    #[serde(rename = "mediaUrls")]
    pub media_urls: Vec<String>,
}

/// Settings used by the MS Teams plugin runtime.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MSTeamsSettings {
    /// Bot App ID.
    #[serde(rename = "appId")]
    pub app_id: String,
    /// Webhook server port.
    #[serde(rename = "webhookPort")]
    pub webhook_port: u16,
    /// Allowed tenant IDs.
    #[serde(rename = "allowedTenants")]
    pub allowed_tenants: Vec<String>,
    /// Whether the service is enabled.
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            MSTeamsEventType::MessageReceived.to_string(),
            "MSTEAMS_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_conversation_type_display() {
        assert_eq!(ConversationType::Personal.to_string(), "personal");
        assert_eq!(ConversationType::GroupChat.to_string(), "groupChat");
        assert_eq!(ConversationType::Channel.to_string(), "channel");
    }

    #[test]
    fn test_user_display_name() {
        let user = MSTeamsUser {
            id: "user-id".to_string(),
            name: Some("Test User".to_string()),
            aad_object_id: None,
            email: Some("test@example.com".to_string()),
            user_principal_name: None,
        };
        assert_eq!(user.display_name(), "Test User");

        let user_no_name = MSTeamsUser {
            id: "user-id".to_string(),
            name: None,
            aad_object_id: None,
            email: Some("test@example.com".to_string()),
            user_principal_name: None,
        };
        assert_eq!(user_no_name.display_name(), "test@example.com");

        let user_only_id = MSTeamsUser {
            id: "user-id".to_string(),
            name: None,
            aad_object_id: None,
            email: None,
            user_principal_name: None,
        };
        assert_eq!(user_only_id.display_name(), "user-id");
    }

    #[test]
    fn test_serialization() {
        let payload = MSTeamsMessagePayload {
            activity_id: "activity-123".to_string(),
            conversation_id: "conv-456".to_string(),
            conversation_type: ConversationType::Personal,
            from: MSTeamsUser {
                id: "user-789".to_string(),
                name: Some("Test User".to_string()),
                aad_object_id: None,
                email: None,
                user_principal_name: None,
            },
            conversation: MSTeamsConversation {
                id: "conv-456".to_string(),
                conversation_type: Some(ConversationType::Personal),
                tenant_id: Some("tenant-abc".to_string()),
                name: None,
                is_group: Some(false),
            },
            service_url: "https://smba.trafficmanager.net/".to_string(),
            text: Some("Hello, world!".to_string()),
            timestamp: 1234567890,
            reply_to_id: None,
            channel_data: None,
        };

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("activityId"));
        assert!(json.contains("activity-123"));
    }
}
