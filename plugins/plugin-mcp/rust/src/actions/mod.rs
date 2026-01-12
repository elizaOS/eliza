//! MCP actions module.
//!
//! Contains action implementations for MCP operations.

mod call_tool;
mod read_resource;

pub use call_tool::CallToolAction;
pub use read_resource::ReadResourceAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::McpResult;

/// Context for action execution.
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// Message text
    pub message_text: String,
    /// Current state
    pub state: Value,
}

/// Result of an action execution.
#[derive(Debug, Clone)]
pub struct ActionResult {
    /// Success status
    pub success: bool,
    /// Result text
    pub text: String,
    /// Structured values
    pub values: Value,
    /// Structured data
    pub data: Value,
}

/// Trait for MCP actions.
#[async_trait]
pub trait McpAction: Send + Sync {
    /// Get action name.
    fn name(&self) -> &'static str;

    /// Get action description.
    fn description(&self) -> &'static str;

    /// Get similar action names.
    fn similes(&self) -> Vec<&'static str>;

    /// Validate if the action should run.
    async fn validate(&self, context: &ActionContext) -> McpResult<bool>;

    /// Execute the action.
    async fn execute(&self, context: &ActionContext) -> McpResult<ActionResult>;
}
