#![allow(missing_docs)]

pub mod issue_context;
pub mod repository_state;

pub use issue_context::GitHubIssueContextProvider;
pub use issue_context::IssueContextProvider;
pub use repository_state::GitHubRepositoryStateProvider;
pub use repository_state::RepositoryStateProvider;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::GitHubService;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderContext {
    pub message: Value,
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResult {
    pub context: String,
    pub data: Value,
}

pub trait GitHubProvider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn get(
        &self,
        context: &ProviderContext,
        service: &GitHubService,
    ) -> impl std::future::Future<Output = Result<ProviderResult>> + Send;
}
