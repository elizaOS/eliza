#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::json;

use super::{ActionContext, ActionResult, GitHubAction};
use crate::error::Result;
use crate::types::{CreateCommitParams, FileChange};
use crate::GitHubService;

pub struct PushCodeAction;

#[async_trait]
impl GitHubAction for PushCodeAction {
    fn name(&self) -> &str {
        "PUSH_GITHUB_CODE"
    }

    fn description(&self) -> &str {
        "Creates a commit with file changes and pushes to a GitHub branch."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "COMMIT_CODE",
            "PUSH_CHANGES",
            "COMMIT_FILES",
            "PUSH_FILES",
            "GIT_PUSH",
            "SAVE_CODE",
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

        Ok(text.contains("push")
            || text.contains("commit")
            || text.contains("save")
            || text.contains("upload"))
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

        let message = context
            .state
            .get("message")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.chars().take(100).collect());

        let branch = context
            .state
            .get("branch")
            .and_then(|b| b.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "main".to_string());

        let files: Vec<FileChange> = context
            .state
            .get("files")
            .and_then(|f| serde_json::from_value(f.clone()).ok())
            .unwrap_or_default();

        if files.is_empty() {
            return Ok(ActionResult::error("No files to commit"));
        }

        let author_name = context
            .state
            .get("authorName")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string());

        let author_email = context
            .state
            .get("authorEmail")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string());

        let params = CreateCommitParams {
            owner: context.owner.clone(),
            repo: context.repo.clone(),
            message,
            files,
            branch,
            parent_sha: None,
            author_name,
            author_email,
        };

        let commit = service.create_commit(params).await?;
        let short_sha = commit.sha.chars().take(7).collect::<String>();

        Ok(ActionResult::success(
            format!("Pushed commit {} to {}", short_sha, &commit.html_url),
            json!({
                "sha": commit.sha,
                "html_url": commit.html_url,
                "message": commit.message,
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate_with_push_keyword() {
        let action = PushCodeAction;
        let context = ActionContext {
            message: json!({
                "content": { "text": "Push the changes to the repository" }
            }),
            owner: "test".to_string(),
            repo: "test".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_with_commit_keyword() {
        let action = PushCodeAction;
        let context = ActionContext {
            message: json!({
                "content": { "text": "Commit these files to the repository" }
            }),
            owner: "test".to_string(),
            repo: "test".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_keywords() {
        let action = PushCodeAction;
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

    #[test]
    fn test_action_properties() {
        let action = PushCodeAction;
        assert_eq!(action.name(), "PUSH_GITHUB_CODE");
        assert!(!action.description().is_empty());
        assert!(action.similes().contains(&"COMMIT_CODE"));
        assert!(action.similes().contains(&"PUSH_CHANGES"));
    }
}
