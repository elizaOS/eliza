#![allow(missing_docs)]

pub mod create_issue;
pub mod create_pull_request;
pub mod create_comment;
pub mod create_branch;
pub mod merge_pull_request;
pub mod push_code;
pub mod review_pull_request;

pub use create_issue::CreateIssueAction;
pub use create_pull_request::CreatePullRequestAction;
pub use create_comment::CreateCommentAction;
pub use create_branch::CreateBranchAction;
pub use merge_pull_request::MergePullRequestAction;
pub use push_code::PushCodeAction;
pub use review_pull_request::ReviewPullRequestAction;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::GitHubService;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionContext {
    pub message: Value,
    pub owner: String,
    pub repo: String,
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub success: bool,
    pub message: String,
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


