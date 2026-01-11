//! GitHub providers for elizaOS
//!
//! Providers supply contextual information to the agent.

pub mod repository_state;
pub mod issue_context;

pub use repository_state::RepositoryStateProvider;
pub use issue_context::IssueContextProvider;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::GitHubService;

/// Provider context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderContext {
    /// Message data
    pub message: Value,
    /// Current state
    pub state: Value,
}

/// Provider result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResult {
    /// Context string for the agent
    pub context: String,
    /// Structured data
    pub data: Value,
}

/// GitHub provider trait
pub trait GitHubProvider: Send + Sync {
    /// Provider name
    fn name(&self) -> &str;

    /// Provider description
    fn description(&self) -> &str;

    /// Get provider context
    fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> impl std::future::Future<Output = Result<ProviderResult>> + Send;
}


