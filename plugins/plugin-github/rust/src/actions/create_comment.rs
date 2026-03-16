#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::json;

use super::{ActionContext, ActionResult, GitHubAction};
use crate::error::Result;
use crate::types::CreateCommentParams;
use crate::GitHubService;

pub struct CreateCommentAction;

#[async_trait]
impl GitHubAction for CreateCommentAction {
    fn name(&self) -> &str {
        "CREATE_GITHUB_COMMENT"
    }

    fn description(&self) -> &str {
        "Creates a comment on a GitHub issue or pull request."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "COMMENT_ON_ISSUE",
            "COMMENT_ON_PR",
            "ADD_COMMENT",
            "REPLY_TO_ISSUE",
            "POST_COMMENT",
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

        Ok(text.contains("comment") || text.contains("reply") || text.contains("respond"))
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

        let issue_number = context
            .state
            .get("issue_number")
            .and_then(|n| n.as_u64())
            .unwrap_or(0);

        let params = CreateCommentParams {
            owner: context.owner.clone(),
            repo: context.repo.clone(),
            issue_number,
            body: text.to_string(),
        };

        let comment = service.create_comment(params).await?;

        Ok(ActionResult::success(
            format!("Added comment to #{}", issue_number),
            json!({
                "comment_id": comment.id,
                "html_url": comment.html_url,
            }),
        ))
    }
}
