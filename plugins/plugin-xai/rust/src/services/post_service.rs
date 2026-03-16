//! Post service for X (Twitter) operations.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::info;

/// Interface for post service operations.
#[async_trait]
pub trait IPostService: Send + Sync {
    /// Create a new post.
    async fn create_post(&self, text: &str, reply_to: Option<&str>) -> crate::error::Result<Value>;

    /// Get a specific post.
    async fn get_post(&self, post_id: &str) -> crate::error::Result<Option<Value>>;

    /// Like a post.
    async fn like_post(&self, post_id: &str) -> crate::error::Result<bool>;

    /// Repost (retweet) a post.
    async fn repost(&self, post_id: &str) -> crate::error::Result<bool>;
}

/// Post service implementation for X posts/tweets.
pub struct PostService {
    is_running: Arc<AtomicBool>,
}

impl PostService {
    /// Creates a new post service.
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Starts the post service.
    pub async fn start(&self) -> crate::error::Result<()> {
        self.is_running.store(true, Ordering::SeqCst);
        info!("PostService started");
        Ok(())
    }

    /// Stops the post service.
    pub async fn stop(&self) -> crate::error::Result<()> {
        self.is_running.store(false, Ordering::SeqCst);
        info!("PostService stopped");
        Ok(())
    }

    /// Checks if the service is running.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }
}

impl Default for PostService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl IPostService for PostService {
    async fn create_post(&self, text: &str, reply_to: Option<&str>) -> crate::error::Result<Value> {
        // Placeholder - actual implementation would use X API client
        info!("Creating post: {}...", &text[..text.len().min(50)]);
        Ok(serde_json::json!({
            "id": "placeholder",
            "text": text,
            "reply_to": reply_to,
            "created": true,
        }))
    }

    async fn get_post(&self, post_id: &str) -> crate::error::Result<Option<Value>> {
        // Placeholder - actual implementation would use X API client
        info!("Getting post: {}", post_id);
        Ok(None)
    }

    async fn like_post(&self, post_id: &str) -> crate::error::Result<bool> {
        // Placeholder - actual implementation would use X API client
        info!("Liking post: {}", post_id);
        Ok(true)
    }

    async fn repost(&self, post_id: &str) -> crate::error::Result<bool> {
        // Placeholder - actual implementation would use X API client
        info!("Reposting: {}", post_id);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_post_service_lifecycle() {
        let service = PostService::new();
        assert!(!service.is_running());

        service.start().await.unwrap();
        assert!(service.is_running());

        service.stop().await.unwrap();
        assert!(!service.is_running());
    }

    #[tokio::test]
    async fn test_create_post() {
        let service = PostService::new();
        let result = service.create_post("Hello world!", None).await.unwrap();
        assert_eq!(result["created"], true);
    }

    #[tokio::test]
    async fn test_like_post() {
        let service = PostService::new();
        let result = service.like_post("post123").await.unwrap();
        assert!(result);
    }
}
