//! Action interfaces and built-in actions for the Zalo service.

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

pub mod send_message;

pub use send_message::SendMessageAction;

/// Context provided to actions during execution.
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// The incoming message data.
    pub message: Value,
    /// The user ID of the sender.
    pub user_id: String,
    /// Current state/memory.
    pub state: Value,
}

/// Trait for Zalo actions.
#[async_trait]
pub trait ZaloAction: Send + Sync {
    /// Returns the action name.
    fn name(&self) -> &'static str;

    /// Returns a description of the action.
    fn description(&self) -> &'static str;

    /// Validates whether this action should be executed.
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Executes the action and returns the result.
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}

/// Returns all built-in actions.
pub fn builtin_actions() -> Vec<Box<dyn ZaloAction>> {
    vec![Box::new(SendMessageAction)]
}
