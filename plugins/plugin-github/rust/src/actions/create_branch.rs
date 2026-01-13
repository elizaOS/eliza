#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::json;

use super::{ActionContext, ActionResult, GitHubAction};
use crate::error::Result;
use crate::types::CreateBranchParams;
use crate::GitHubService;

pub struct CreateBranchAction;

#[async_trait]
impl GitHubAction for CreateBranchAction {
    fn name(&self) -> &str {
        "CREATE_GITHUB_BRANCH"
    }

    fn description(&self) -> &str {
        "Creates a new branch in a GitHub repository from an existing branch or commit."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "NEW_BRANCH",
            "BRANCH_FROM",
            "FORK_BRANCH",
            "CREATE_FEATURE_BRANCH",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_lowercase();

        Ok(text.contains("branch") || text.contains("fork") || text.contains("checkout"))
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &GitHubService,
    ) -> Result<ActionResult> {
        let branch_name = context
            .state
            .get("branch_name")
            .and_then(|n| n.as_str())
            .unwrap_or("new-branch");

        let from_ref = context
            .state
            .get("from_ref")
            .and_then(|r| r.as_str())
            .unwrap_or(&service.config().branch);

        let params = CreateBranchParams {
            owner: context.owner.clone(),
            repo: context.repo.clone(),
            branch_name: branch_name.to_string(),
            from_ref: from_ref.to_string(),
        };

        let branch = service.create_branch(params).await?;

        Ok(ActionResult::success(
            format!("Created branch '{}' from {}", branch.name, from_ref),
            json!({
                "branch_name": branch.name,
                "sha": branch.sha,
            }),
        ))
    }
}
