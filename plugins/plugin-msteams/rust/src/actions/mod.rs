//! Action interfaces and built-in actions for the MS Teams service.

pub mod send_message;

pub use send_message::{SendMessageAction, SendPollAction, SendAdaptiveCardAction};

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

/// Context provided to action handlers.
pub struct ActionContext {
    /// The incoming message data.
    pub message: Value,
    /// Conversation ID.
    pub conversation_id: String,
    /// User ID who triggered the action.
    pub user_id: String,
    /// Tenant ID.
    pub tenant_id: Option<String>,
    /// Agent state.
    pub state: Value,
}

/// Trait for MS Teams actions.
#[async_trait]
pub trait MSTeamsAction: Send + Sync {
    /// Returns the action name.
    fn name(&self) -> &'static str;

    /// Returns a description of the action.
    fn description(&self) -> &'static str;

    /// Validates whether this action should be executed.
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Executes the action and returns a result value.
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}
