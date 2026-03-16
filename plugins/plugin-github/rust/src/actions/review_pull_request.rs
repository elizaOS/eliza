#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::json;

use super::{ActionContext, ActionResult, GitHubAction};
use crate::error::Result;
use crate::types::{CreateReviewParams, ReviewEvent, ReviewState};
use crate::GitHubService;

pub struct ReviewPullRequestAction;

impl ReviewPullRequestAction {
    fn determine_review_event(text: &str) -> ReviewEvent {
        let lower = text.to_lowercase();

        if lower.contains("approve") || lower.contains("lgtm") || lower.contains("looks good") {
            ReviewEvent::Approve
        } else if lower.contains("request changes")
            || lower.contains("needs work")
            || lower.contains("fix")
        {
            ReviewEvent::RequestChanges
        } else {
            ReviewEvent::Comment
        }
    }
}

#[async_trait]
impl GitHubAction for ReviewPullRequestAction {
    fn name(&self) -> &str {
        "REVIEW_GITHUB_PULL_REQUEST"
    }

    fn description(&self) -> &str {
        "Creates a review on a GitHub pull request. Can approve, request changes, or add comments."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "APPROVE_PR",
            "REQUEST_CHANGES",
            "COMMENT_ON_PR",
            "REVIEW_PR",
            "PR_REVIEW",
            "CODE_REVIEW",
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

        Ok(text.contains("review")
            || text.contains("approve")
            || text.contains("request changes")
            || text.contains("lgtm"))
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

        let pull_number = context
            .state
            .get("pullNumber")
            .and_then(|p| p.as_u64())
            .unwrap_or(0);

        if pull_number == 0 {
            return Ok(ActionResult::error("Pull request number is required"));
        }

        // Get review body from state or use text
        let body = context
            .state
            .get("body")
            .and_then(|b| b.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.to_string());

        let event = context
            .state
            .get("event")
            .and_then(|e| e.as_str())
            .map(|e| match e.to_uppercase().as_str() {
                "APPROVE" => ReviewEvent::Approve,
                "REQUEST_CHANGES" => ReviewEvent::RequestChanges,
                _ => ReviewEvent::Comment,
            })
            .unwrap_or_else(|| Self::determine_review_event(text));

        let params = CreateReviewParams {
            owner: context.owner.clone(),
            repo: context.repo.clone(),
            pull_number,
            body: Some(body),
            event,
            comments: Vec::new(),
            commit_id: None,
        };

        let review = service.create_review(params).await?;

        let event_label = match review.state {
            ReviewState::Approved => "approved",
            ReviewState::ChangesRequested => "requested changes on",
            ReviewState::Commented | ReviewState::Dismissed | ReviewState::Pending => {
                "commented on"
            }
        };

        Ok(ActionResult::success(
            format!("Created {} review on PR #{}", event_label, pull_number),
            json!({
                "id": review.id,
                "state": review.state,
                "html_url": review.html_url,
                "body": review.body,
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate_with_review_keyword() {
        let action = ReviewPullRequestAction;
        let context = ActionContext {
            message: json!({
                "content": { "text": "Review pull request #42" }
            }),
            owner: "test".to_string(),
            repo: "test".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_with_approve_keyword() {
        let action = ReviewPullRequestAction;
        let context = ActionContext {
            message: json!({
                "content": { "text": "Approve the pull request" }
            }),
            owner: "test".to_string(),
            repo: "test".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_with_lgtm_keyword() {
        let action = ReviewPullRequestAction;
        let context = ActionContext {
            message: json!({
                "content": { "text": "LGTM on this PR" }
            }),
            owner: "test".to_string(),
            repo: "test".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_keywords() {
        let action = ReviewPullRequestAction;
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
    fn test_determine_review_event_approve() {
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("Approve this PR"),
            ReviewEvent::Approve
        ));
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("LGTM"),
            ReviewEvent::Approve
        ));
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("Looks good to me"),
            ReviewEvent::Approve
        ));
    }

    #[test]
    fn test_determine_review_event_request_changes() {
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("Request changes on this"),
            ReviewEvent::RequestChanges
        ));
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("Needs work"),
            ReviewEvent::RequestChanges
        ));
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("Please fix this issue"),
            ReviewEvent::RequestChanges
        ));
    }

    #[test]
    fn test_determine_review_event_comment() {
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("Just a comment"),
            ReviewEvent::Comment
        ));
        assert!(matches!(
            ReviewPullRequestAction::determine_review_event("What about this?"),
            ReviewEvent::Comment
        ));
    }

    #[test]
    fn test_action_properties() {
        let action = ReviewPullRequestAction;
        assert_eq!(action.name(), "REVIEW_GITHUB_PULL_REQUEST");
        assert!(!action.description().is_empty());
        assert!(action.similes().contains(&"APPROVE_PR"));
        assert!(action.similes().contains(&"CODE_REVIEW"));
    }
}
