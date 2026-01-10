//! GitHub actions for elizaOS
//!
//! All available actions for the GitHub plugin.

pub mod create_issue;
pub mod create_pull_request;
pub mod create_comment;
pub mod create_branch;
pub mod merge_pull_request;

pub use create_issue::CreateIssueAction;
pub use create_pull_request::CreatePullRequestAction;
pub use create_comment::CreateCommentAction;
pub use create_branch::CreateBranchAction;
pub use merge_pull_request::MergePullRequestAction;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::GitHubService;

/// Action context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionContext {
    /// Message data
    pub message: Value,
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// Current state
    pub state: Value,
}

/// Action result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    /// Whether action succeeded
    pub success: bool,
    /// Result message
    pub message: String,
    /// Result data
    pub data: Value,
}

impl ActionResult {
    /// Create success result
    pub fn success(message: impl Into<String>, data: Value) -> Self {
        Self {
            success: true,
            message: message.into(),
            data,
        }
    }

    /// Create error result
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            data: Value::Null,
        }
    }
}

/// GitHub action trait
#[async_trait]
pub trait GitHubAction: Send + Sync {
    /// Action name
    fn name(&self) -> &str;

    /// Action description
    fn description(&self) -> &str;

    /// Similar action names
    fn similes(&self) -> Vec<&str>;

    /// Validate if action can be executed
    async fn validate(&self, context: &ActionContext) -> Result<bool>;

    /// Execute the action
    async fn handler(
        &self,
        context: &ActionContext,
        service: &GitHubService,
    ) -> Result<ActionResult>;
}

