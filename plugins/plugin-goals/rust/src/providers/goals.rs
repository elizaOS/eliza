//! Goals provider (TS parity name: `GOALS`)

use async_trait::async_trait;
use serde_json::Value;

use super::{GoalProvider, ProviderContext};

use super::goals_state::GoalsStateProvider;

/// Provider for goals information (TS parity: `GOALS`).
pub struct GoalsProvider;

#[async_trait]
impl GoalProvider for GoalsProvider {
    fn name(&self) -> &'static str {
        "GOALS"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        // Minimal parity implementation: reuse the existing state provider.
        GoalsStateProvider.get(context).await
    }
}
