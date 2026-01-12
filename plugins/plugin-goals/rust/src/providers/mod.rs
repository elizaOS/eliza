//! Goals providers module
//!
//! Contains provider implementations for goal state.

mod goals_state;
mod goals;

pub use goals_state::GoalsStateProvider;
pub use goals::GoalsProvider;

use async_trait::async_trait;
use serde_json::Value;

/// Context for provider operations
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// Agent ID
    pub agent_id: Option<String>,
    /// Entity/User ID
    pub entity_id: Option<String>,
    /// Room/conversation ID
    pub room_id: Option<String>,
}

/// Trait for Goal providers
#[async_trait]
pub trait GoalProvider: Send + Sync {
    /// Get provider name
    fn name(&self) -> &'static str;

    /// Get current state
    async fn get(&self, context: &ProviderContext) -> Value;
}
