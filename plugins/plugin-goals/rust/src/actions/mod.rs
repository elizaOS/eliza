//! Goals actions module
//!
//! Contains action implementations for goal operations.

mod cancel_goal;
mod complete_goal;
mod confirm_goal;
mod create_goal;
mod update_goal;

pub use cancel_goal::CancelGoalAction;
pub use complete_goal::CompleteGoalAction;
pub use confirm_goal::ConfirmGoalAction;
pub use create_goal::CreateGoalAction;
pub use update_goal::UpdateGoalAction;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;

/// Context for action execution
#[derive(Debug, Clone)]
pub struct ActionContext {
    /// Original message data
    pub message: Value,
    /// Agent ID
    pub agent_id: String,
    /// Entity/User ID
    pub entity_id: String,
    /// Room/conversation ID
    pub room_id: Option<String>,
    /// Current state
    pub state: Value,
}

/// Trait for Goal actions
#[async_trait]
pub trait GoalAction: Send + Sync {
    /// Get action name
    fn name(&self) -> &'static str;

    /// Get action description
    fn description(&self) -> &'static str;

    /// Validate if action should run
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Execute the action
    async fn execute(&self, context: &ActionContext) -> Result<Value>;
}
