//! Action interfaces and built-in actions for the Feishu plugin.

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

mod send_message;

pub use send_message::SendMessageAction;

/// Context provided to action handlers.
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// The incoming message data.
    pub message: Value,
    /// The chat ID where the action is being performed.
    pub chat_id: String,
    /// The user ID who triggered the action.
    pub user_id: String,
    /// Current conversation state.
    pub state: Value,
}

/// Trait for implementing Feishu actions.
#[async_trait]
pub trait FeishuAction: Send + Sync {
    /// Returns the action name.
    fn name(&self) -> &'static str;

    /// Returns a human-readable description of the action.
    fn description(&self) -> &'static str;

    /// Validates whether this action should be executed.
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Executes the action and returns a result payload.
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}
