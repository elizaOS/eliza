//! Instagram actions module
//!
//! Contains action implementations for Instagram operations.

mod post_comment;
mod send_dm;

pub use post_comment::PostCommentAction;
pub use send_dm::SendDmAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

/// Context for action execution
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// Original message data
    pub message: Value,
    /// User ID
    pub user_id: i64,
    /// Thread ID (for DMs)
    pub thread_id: Option<String>,
    /// Media ID (for comments)
    pub media_id: Option<i64>,
    /// Current state
    pub state: Value,
}

/// Trait for Instagram actions
#[async_trait]
pub trait InstagramAction: Send + Sync {
    /// Get action name
    fn name(&self) -> &'static str;

    /// Get action description
    fn description(&self) -> &'static str;

    /// Validate if action should run
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Execute the action
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}
