//! Discord actions for elizaOS
//!
//! Actions define what the agent can do on Discord.

mod send_message;
mod send_dm;
mod add_reaction;

pub use send_message::SendMessageAction;
pub use send_dm::SendDmAction;
pub use add_reaction::AddReactionAction;

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
    ]
}
