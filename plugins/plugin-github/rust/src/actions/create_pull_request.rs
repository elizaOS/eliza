#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::json;

use super::{ActionContext, ActionResult, GitHubAction};
use crate::error::Result;
use crate::types::CreatePullRequestParams;
use crate::GitHubService;

pub struct CreatePullRequestAction;

#[async_trait]
impl GitHubAction for CreatePullRequestAction {
    fn name(&self) -> &str {
        "CREATE_GITHUB_PULL_REQUEST"
    }

    fn description(&self) -> &str {
        "Creates a new pull request in a GitHub repository to merge changes from one branch to another."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "OPEN_PR",
            "CREATE_PR",
            "NEW_PULL_REQUEST",
            "SUBMIT_PR",
            "OPEN_PULL_REQUEST",
            "MERGE_REQUEST",
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

        Ok(text.contains("pull request") || text.contains("pr") || text.contains("merge"))
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &GitHubService,
    ) -> Result<ActionResult> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let head = context
            .state
            .get("head")
            .and_then(|h| h.as_str())
            .unwrap_or("feature");

        let base = context
            .state
            .get("base")
            .and_then(|b| b.as_str())
            .unwrap_or(&service.config().branch);

        let title = context
            .state
            .get("title")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.chars().take(100).collect());

        let params = CreatePullRequestParams {
            owner: context.owner.clone(),
            repo: context.repo.clone(),
            title,
            body: Some(text.to_string()),
            head: head.to_string(),
            base: base.to_string(),
            draft: false,
            maintainer_can_modify: true,
        };

        let pr = service.create_pull_request(params).await?;

        Ok(ActionResult::success(
            format!("Created pull request #{}: {}", pr.number, pr.title),
            json!({
                "pull_number": pr.number,
                "html_url": pr.html_url,
                "head": pr.head.branch_ref,
                "base": pr.base.branch_ref,
            }),
        ))
    }
}
