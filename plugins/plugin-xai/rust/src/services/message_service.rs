//! Message service for X (Twitter) interactions.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::info;

/// Interface for message service operations.
#[async_trait]
pub trait IMessageService: Send + Sync {
    /// Send a direct message.
    async fn send_message(&self, recipient_id: &str, text: &str) -> crate::error::Result<Value>;

    /// Get messages from conversations.
    async fn get_messages(&self, conversation_id: Option<&str>)
        -> crate::error::Result<Vec<Value>>;
}

/// Message service implementation for X direct messages.
pub struct MessageService {
    is_running: Arc<AtomicBool>,
}

impl MessageService {
    /// Creates a new message service.
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Starts the message service.
    pub async fn start(&self) -> crate::error::Result<()> {
        self.is_running.store(true, Ordering::SeqCst);
        info!("MessageService started");
        Ok(())
    }

    /// Stops the message service.
    pub async fn stop(&self) -> crate::error::Result<()> {
        self.is_running.store(false, Ordering::SeqCst);
        info!("MessageService stopped");
        Ok(())
    }

    /// Checks if the service is running.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }
}

impl Default for MessageService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl IMessageService for MessageService {
    async fn send_message(&self, recipient_id: &str, text: &str) -> crate::error::Result<Value> {
        // Placeholder - actual implementation would use X API client
        info!(
            "Sending message to {}: {}...",
            recipient_id,
            &text[..text.len().min(50)]
        );
        Ok(serde_json::json!({
            "id": "placeholder",
            "recipient_id": recipient_id,
            "text": text,
            "sent": true,
        }))
    }

    async fn get_messages(
        &self,
        conversation_id: Option<&str>,
    ) -> crate::error::Result<Vec<Value>> {
        // Placeholder - actual implementation would use X API client
        info!("Getting messages for conversation: {:?}", conversation_id);
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_message_service_lifecycle() {
        let service = MessageService::new();
        assert!(!service.is_running());

        service.start().await.unwrap();
        assert!(service.is_running());

        service.stop().await.unwrap();
        assert!(!service.is_running());
    }

    #[tokio::test]
    async fn test_send_message() {
        let service = MessageService::new();
        let result = service.send_message("user123", "Hello!").await.unwrap();
        assert_eq!(result["sent"], true);
    }
}
