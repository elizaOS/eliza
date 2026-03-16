//! Post comment action for Instagram

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, InstagramAction};
use crate::error::Result;

/// Action to post a comment on Instagram media
pub struct PostCommentAction;

#[async_trait]
impl InstagramAction for PostCommentAction {
    fn name(&self) -> &'static str {
        "POST_INSTAGRAM_COMMENT"
    }

    fn description(&self) -> &'static str {
        "Post a comment on an Instagram post or media"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check if this is an Instagram message with a media ID
        let source = context.message.get("source").and_then(|v| v.as_str());
        let has_media = context.media_id.is_some();
        Ok(source == Some("instagram") && has_media)
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let response_text = context
            .state
            .get("response")
            .and_then(|v| v.get("text"))
            .and_then(|v| v.as_str())
            .or_else(|| context.message.get("text").and_then(|v| v.as_str()))
            .unwrap_or("");

        Ok(serde_json::json!({
            "action": self.name(),
            "media_id": context.media_id,
            "text": response_text
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_instagram_source_with_media() {
        let action = PostCommentAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "instagram",
                "text": "Great post!"
            }),
            user_id: 12345,
            thread_id: None,
            media_id: Some(67890),
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_instagram_source() {
        let action = PostCommentAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "telegram",
                "text": "Great post!"
            }),
            user_id: 12345,
            thread_id: None,
            media_id: Some(67890),
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_no_media() {
        let action = PostCommentAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "instagram",
                "text": "Great post!"
            }),
            user_id: 12345,
            thread_id: None,
            media_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute_with_response() {
        let action = PostCommentAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "instagram",
                "text": "fallback text"
            }),
            user_id: 12345,
            thread_id: None,
            media_id: Some(67890),
            state: serde_json::json!({
                "response": {
                    "text": "This is a great post!"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "POST_INSTAGRAM_COMMENT");
        assert_eq!(result["media_id"], 67890);
        assert_eq!(result["text"], "This is a great post!");
    }

    #[tokio::test]
    async fn test_execute_with_fallback_text() {
        let action = PostCommentAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "instagram",
                "text": "Fallback comment"
            }),
            user_id: 12345,
            thread_id: None,
            media_id: Some(67890),
            state: serde_json::json!({}),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["text"], "Fallback comment");
    }
}
