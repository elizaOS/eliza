//! Telegram actions module
//!
//! Contains action implementations for Telegram operations.

mod send_message;

pub use send_message::SendMessageAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

/// Context for action execution
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// Original message data
    pub message: Value,
    /// Chat ID
    pub chat_id: i64,
    /// User ID
    pub user_id: i64,
    /// Thread ID (for forum topics)
    pub thread_id: Option<i64>,
    /// Current state
    pub state: Value,
}

/// Trait for Telegram actions
#[async_trait]
pub trait TelegramAction: Send + Sync {
    /// Get action name
    fn name(&self) -> &'static str;

    /// Get action description
    fn description(&self) -> &'static str;

    /// Validate if action should run
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Execute the action
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}
