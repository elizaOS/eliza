//! Discord actions for elizaOS
//!
//! Actions define what the agent can do on Discord.

mod add_reaction;
mod chat_with_attachments;
mod create_poll;
mod download_media;
mod get_user_info;
mod join_channel;
mod leave_channel;
mod list_channels;
mod pin_message;
mod react_to_message;
mod read_channel;
mod search_messages;
mod send_dm;
mod send_message;
mod server_info;
mod summarize_conversation;
mod transcribe_media;
mod unpin_message;

pub use add_reaction::AddReactionAction;
pub use chat_with_attachments::ChatWithAttachmentsAction;
pub use create_poll::CreatePollAction;
pub use download_media::DownloadMediaAction;
pub use get_user_info::GetUserInfoAction;
pub use join_channel::JoinChannelAction;
pub use leave_channel::LeaveChannelAction;
pub use list_channels::ListChannelsAction;
pub use pin_message::PinMessageAction;
pub use react_to_message::ReactToMessageAction;
pub use read_channel::ReadChannelAction;
pub use search_messages::SearchMessagesAction;
pub use send_dm::SendDmAction;
pub use send_message::SendMessageAction;
pub use server_info::ServerInfoAction;
pub use summarize_conversation::SummarizeConversationAction;
pub use transcribe_media::TranscribeMediaAction;
pub use unpin_message::UnpinMessageAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

/// Context provided to actions
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// The incoming message/trigger
    pub message: Value,
    /// Channel ID where action should execute
    pub channel_id: String,
    /// Guild ID (None for DMs)
    pub guild_id: Option<String>,
    /// User ID who triggered the action
    pub user_id: String,
    /// Current agent state
    pub state: Value,
}

/// Result of executing an action
#[derive(Debug, Clone)]
pub struct ActionResult {
    /// Whether the action succeeded
    pub success: bool,
    /// Response content
    pub response: Option<String>,
    /// Additional data
    pub data: Option<Value>,
}

impl ActionResult {
    /// Create a successful result
    pub fn success(response: impl Into<String>) -> Self {
        Self {
            success: true,
            response: Some(response.into()),
            data: None,
        }
    }

    /// Create a successful result with data
    pub fn success_with_data(response: impl Into<String>, data: Value) -> Self {
        Self {
            success: true,
            response: Some(response.into()),
            data: Some(data),
        }
    }

    /// Create a failed result
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            success: false,
            response: Some(message.into()),
            data: None,
        }
    }
}

/// Trait for Discord actions
#[async_trait]
pub trait DiscordAction: Send + Sync {
    /// Action name
    fn name(&self) -> &str;

    /// Action description
    fn description(&self) -> &str;

    /// Similar names/aliases for this action
    fn similes(&self) -> Vec<&str>;

    /// Validate the action can be executed
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Execute the action
    async fn handler(
        &self,
        context: &ActionContext,
        service: &crate::DiscordService,
    ) -> Result<ActionResult>;
}

/// Get all available actions
pub fn get_all_actions() -> Vec<Box<dyn DiscordAction>> {
    vec![
        Box::new(SendMessageAction),
        Box::new(SendDmAction),
        Box::new(AddReactionAction),
        Box::new(ChatWithAttachmentsAction),
        Box::new(CreatePollAction),
        Box::new(DownloadMediaAction),
        Box::new(GetUserInfoAction),
        Box::new(JoinChannelAction),
        Box::new(LeaveChannelAction),
        Box::new(ListChannelsAction),
        Box::new(PinMessageAction),
        Box::new(ReactToMessageAction),
        Box::new(ReadChannelAction),
        Box::new(SearchMessagesAction),
        Box::new(ServerInfoAction),
        Box::new(SummarizeConversationAction),
        Box::new(TranscribeMediaAction),
        Box::new(UnpinMessageAction),
    ]
}
