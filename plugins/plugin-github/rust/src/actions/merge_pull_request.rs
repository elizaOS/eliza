#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::json;

use super::{ActionContext, ActionResult, GitHubAction};
use crate::error::Result;
use crate::types::{MergeMethod, MergePullRequestParams};
use crate::GitHubService;

pub struct MergePullRequestAction;

#[async_trait]
impl GitHubAction for MergePullRequestAction {
    fn name(&self) -> &str {
        "MERGE_GITHUB_PULL_REQUEST"
    }

    fn description(&self) -> &str {
        "Merges a GitHub pull request using merge, squash, or rebase strategy."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "MERGE_PR",
            "SQUASH_MERGE",
            "REBASE_MERGE",
            "COMPLETE_PR",
            "ACCEPT_PR",
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

        Ok(text.contains("merge"))
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
            .unwrap_or("")
            .to_lowercase();

        let merge_method = if text.contains("squash") {
            MergeMethod::Squash
        } else if text.contains("rebase") {
            MergeMethod::Rebase
        } else {
            MergeMethod::Merge
        };

        let pull_number = context
            .state
            .get("pull_number")
            .and_then(|n| n.as_u64())
            .unwrap_or(0);

        let params = MergePullRequestParams {
            owner: context.owner.clone(),
            repo: context.repo.clone(),
            pull_number,
            commit_title: None,
            commit_message: None,
            merge_method,
            sha: None,
        };

        let (sha, merged, message) = service.merge_pull_request(params).await?;

        if merged {
            Ok(ActionResult::success(
                format!("Successfully merged pull request #{}", pull_number),
                json!({
                    "sha": sha,
                    "merged": merged,
                    "merge_method": format!("{:?}", merge_method).to_lowercase(),
                }),
            ))
        } else {
            Ok(ActionResult::error(format!(
                "Could not merge pull request #{}: {}",
                pull_number, message
            )))
        }
    }
}
