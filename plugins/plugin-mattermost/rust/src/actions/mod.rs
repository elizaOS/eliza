mod send_message;

pub use send_message::SendMessageAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

#[derive(Debug, Clone)]
/// Context passed to Mattermost actions.
pub struct ActionContext {
    /// Raw incoming message/event payload.
    pub message: Value,
    /// Mattermost channel ID the action is operating on.
    pub channel_id: String,
    /// Mattermost user ID that initiated the action.
    pub user_id: String,
    /// Optional root post ID (for thread replies).
    pub root_id: Option<String>,
    /// Current agent/plugin state, including the response to send.
    pub state: Value,
}

#[async_trait]
/// Trait implemented by Mattermost actions.
pub trait MattermostAction: Send + Sync {
    /// Machine-readable action name.
    fn name(&self) -> &'static str;

    /// Human-friendly description of the action.
    fn description(&self) -> &'static str;

    /// Validates whether the action can run for the given context.
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Executes the action and returns a JSON result.
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}
