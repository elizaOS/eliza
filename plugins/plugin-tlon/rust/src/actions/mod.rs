//! Actions for the Tlon plugin.

mod send_message;

pub use send_message::SendMessageAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

/// Context for action execution.
pub struct ActionContext {
    /// The incoming message.
    pub message: Value,
    /// Target ship (for DMs).
    pub ship: Option<String>,
    /// Target channel nest (for groups).
    pub channel_nest: Option<String>,
    /// Reply to message ID.
    pub reply_to_id: Option<String>,
    /// Current state.
    pub state: Value,
}

/// Trait for Tlon actions.
#[async_trait]
pub trait TlonAction: Send + Sync {
    /// Returns the action name.
    fn name(&self) -> &'static str;

    /// Returns the action description.
    fn description(&self) -> &'static str;

    /// Validates whether this action can handle the given context.
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Executes the action and returns the result.
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}
