mod cancel_plugin;
mod check_status;
mod create_from_description;
mod create_plugin;

pub use cancel_plugin::CancelPluginAction;
pub use check_status::CheckStatusAction;
pub use create_from_description::CreateFromDescriptionAction;
pub use create_plugin::CreatePluginAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

/// Context provided to n8n actions for execution.
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// The text content of the incoming message.
    pub message_text: String,
    /// The current state as a JSON value.
    pub state: Value,
}

/// Result returned from an n8n action execution.
#[derive(Debug, Clone)]
pub struct ActionResult {
    /// Whether the action completed successfully.
    pub success: bool,
    /// Human-readable text describing the result.
    pub text: String,
    /// Optional structured data from the action.
    pub data: Option<Value>,
    /// Optional error message if the action failed.
    pub error: Option<String>,
}

/// Trait defining the interface for n8n actions.
#[async_trait]
pub trait N8nAction: Send + Sync {
    /// Returns the unique name identifier for this action.
    fn name(&self) -> &'static str;
    /// Returns a human-readable description of what this action does.
    fn description(&self) -> &'static str;
    /// Returns alternative phrases that can trigger this action.
    fn similes(&self) -> Vec<&'static str>;
    /// Validates whether this action can be executed in the given context.
    async fn validate(&self, context: &ActionContext) -> Result<bool>;
    /// Executes the action and returns the result.
    async fn execute(&self, context: &ActionContext) -> Result<ActionResult>;
}
