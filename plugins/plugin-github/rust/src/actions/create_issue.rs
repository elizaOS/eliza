#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::json;

use super::{ActionContext, ActionResult, GitHubAction};
use crate::error::Result;
use crate::types::CreateIssueParams;
use crate::GitHubService;

pub struct CreateIssueAction;

#[async_trait]
impl GitHubAction for CreateIssueAction {
    fn name(&self) -> &str {
        "CREATE_GITHUB_ISSUE"
    }

    fn description(&self) -> &str {
        "Creates a new issue in a GitHub repository. Use this to report bugs, request features, or track tasks."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "OPEN_ISSUE",
            "NEW_ISSUE",
            "FILE_ISSUE",
            "REPORT_BUG",
            "CREATE_BUG_REPORT",
            "SUBMIT_ISSUE",
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

        Ok(text.contains("issue")
            || text.contains("bug")
            || text.contains("report")
            || text.contains("ticket"))
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

        let title = context
            .state
            .get("title")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.chars().take(100).collect());

        let params = CreateIssueParams {
            owner: context.owner.clone(),
            repo: context.repo.clone(),
            title,
            body: Some(text.to_string()),
            assignees: Vec::new(),
            labels: Vec::new(),
            milestone: None,
        };

        let issue = service.create_issue(params).await?;

        Ok(ActionResult::success(
            format!("Created issue #{}: {}", issue.number, issue.title),
            json!({
                "issue_number": issue.number,
                "html_url": issue.html_url,
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate_with_issue_keyword() {
        let action = CreateIssueAction;
        let context = ActionContext {
            message: json!({
                "content": { "text": "Create an issue for this bug" }
            }),
            owner: "test".to_string(),
            repo: "test".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_keywords() {
        let action = CreateIssueAction;
        let context = ActionContext {
            message: json!({
                "content": { "text": "Hello world" }
            }),
            owner: "test".to_string(),
            repo: "test".to_string(),
            state: json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }
}
