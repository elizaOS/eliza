//! Instagram service implementation
//!
//! Provides the main InstagramService for connecting to Instagram and handling events.

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info};

use crate::config::InstagramConfig;
use crate::error::{InstagramError, Result};
use crate::types::{
    InstagramEventType, InstagramMedia, InstagramMessage, InstagramThread, InstagramUser,
};
use crate::{MAX_COMMENT_LENGTH, MAX_DM_LENGTH};

/// Event callback type
pub type EventCallback = Box<dyn Fn(InstagramEventType, serde_json::Value) + Send + Sync>;

/// Instagram service state
#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    logged_in_user: Option<InstagramUser>,
}

/// Instagram service for elizaOS
///
/// Manages connection to Instagram and handles all Instagram operations.
pub struct InstagramService {
    config: InstagramConfig,
    state: Arc<RwLock<ServiceState>>,
}

impl InstagramService {
    /// Create a new Instagram service
    pub fn new(config: InstagramConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
        }
    }

    /// Get the configuration
    pub fn config(&self) -> &InstagramConfig {
        &self.config
    }

    /// Check if the service is running
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Get the logged-in user
    pub async fn logged_in_user(&self) -> Option<InstagramUser> {
        self.state.read().await.logged_in_user.clone()
    }

    /// Set the event callback
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(InstagramEventType, serde_json::Value) + Send + Sync + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Start the Instagram service
    pub async fn start(&mut self) -> Result<()> {
        // Check if already running
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(InstagramError::AlreadyRunning);
            }
        }

        // Validate config
        self.config.validate()?;

        info!("Starting Instagram service for @{}...", self.config.username);

        // In a real implementation, this would authenticate with Instagram
        // For now, simulate a logged-in user
        let user = InstagramUser {
            pk: 0,
            username: self.config.username.clone(),
            full_name: None,
            profile_pic_url: None,
            is_private: false,
            is_verified: false,
            follower_count: None,
            following_count: None,
        };

        // Update state
        {
            let mut state = self.state.write().await;
            state.is_running = true;
            state.logged_in_user = Some(user.clone());
        }

        info!("Instagram service started for @{}", self.config.username);
        Ok(())
    }

    /// Stop the Instagram service
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Instagram service...");

        {
            let mut state = self.state.write().await;
            state.is_running = false;
            state.logged_in_user = None;
        }

        info!("Instagram service stopped");
        Ok(())
    }

    /// Send a direct message
    pub async fn send_direct_message(&self, thread_id: &str, text: &str) -> Result<String> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        if text.len() > MAX_DM_LENGTH {
            return Err(InstagramError::ContentTooLong {
                length: text.len(),
                max: MAX_DM_LENGTH,
            });
        }

        debug!("Sending DM to thread {}: {}...", thread_id, &text[..text.len().min(50)]);

        // In a real implementation, this would send via Instagram API
        let message_id = format!("msg_{}", chrono::Utc::now().timestamp_millis());

        Ok(message_id)
    }

    /// Reply to a message
    pub async fn reply_to_message(
        &self,
        thread_id: &str,
        _message_id: &str,
        text: &str,
    ) -> Result<String> {
        // Instagram DMs don't have native reply-to-specific-message
        self.send_direct_message(thread_id, text).await
    }

    /// Post a comment on media
    pub async fn post_comment(&self, media_id: i64, text: &str) -> Result<i64> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        if text.len() > MAX_COMMENT_LENGTH {
            return Err(InstagramError::ContentTooLong {
                length: text.len(),
                max: MAX_COMMENT_LENGTH,
            });
        }

        debug!("Posting comment on media {}: {}...", media_id, &text[..text.len().min(50)]);

        // In a real implementation, this would post via Instagram API
        let comment_id = chrono::Utc::now().timestamp_millis();

        Ok(comment_id)
    }

    /// Reply to a comment
    pub async fn reply_to_comment(
        &self,
        media_id: i64,
        _comment_id: i64,
        text: &str,
    ) -> Result<i64> {
        // In a real implementation, this would tag the original commenter
        self.post_comment(media_id, text).await
    }

    /// Like media
    pub async fn like_media(&self, media_id: i64) -> Result<()> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        debug!("Liking media {}", media_id);
        Ok(())
    }

    /// Unlike media
    pub async fn unlike_media(&self, media_id: i64) -> Result<()> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        debug!("Unliking media {}", media_id);
        Ok(())
    }

    /// Follow a user
    pub async fn follow_user(&self, user_id: i64) -> Result<()> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        debug!("Following user {}", user_id);
        Ok(())
    }

    /// Unfollow a user
    pub async fn unfollow_user(&self, user_id: i64) -> Result<()> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        debug!("Unfollowing user {}", user_id);
        Ok(())
    }

    /// Get user info
    pub async fn get_user_info(&self, user_id: i64) -> Result<InstagramUser> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        // In a real implementation, this would fetch from Instagram API
        Ok(InstagramUser {
            pk: user_id,
            username: format!("user_{}", user_id),
            full_name: None,
            profile_pic_url: None,
            is_private: false,
            is_verified: false,
            follower_count: None,
            following_count: None,
        })
    }

    /// Get user by username
    pub async fn get_user_by_username(&self, username: &str) -> Result<InstagramUser> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        // In a real implementation, this would fetch from Instagram API
        Ok(InstagramUser {
            pk: 0,
            username: username.to_string(),
            full_name: None,
            profile_pic_url: None,
            is_private: false,
            is_verified: false,
            follower_count: None,
            following_count: None,
        })
    }

    /// Get DM threads
    pub async fn get_threads(&self) -> Result<Vec<InstagramThread>> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        // In a real implementation, this would fetch from Instagram API
        Ok(vec![])
    }

    /// Get messages in a thread
    pub async fn get_thread_messages(&self, _thread_id: &str) -> Result<Vec<InstagramMessage>> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        // In a real implementation, this would fetch from Instagram API
        Ok(vec![])
    }

    /// Get user's media
    pub async fn get_user_media(&self, _user_id: i64) -> Result<Vec<InstagramMedia>> {
        if !self.is_running().await {
            return Err(InstagramError::ClientNotInitialized);
        }

        // In a real implementation, this would fetch from Instagram API
        Ok(vec![])
    }
}

/// Split a message into chunks
pub fn split_message(content: &str, max_length: usize) -> Vec<String> {
    if content.len() <= max_length {
        return vec![content.to_string()];
    }

    let mut parts = Vec::new();
    let mut current = String::new();

    for line in content.lines() {
        let line_with_newline = if current.is_empty() {
            line.to_string()
        } else {
            format!("\n{}", line)
        };

        if current.len() + line_with_newline.len() > max_length {
            if !current.is_empty() {
                parts.push(current);
                current = String::new();
            }

            if line.len() > max_length {
                // Split by words
                let words: Vec<&str> = line.split_whitespace().collect();
                for word in words {
                    let word_with_space = if current.is_empty() {
                        word.to_string()
                    } else {
                        format!(" {}", word)
                    };

                    if current.len() + word_with_space.len() > max_length {
                        if !current.is_empty() {
                            parts.push(current);
                            current = String::new();
                        }

                        if word.len() > max_length {
                            let chars: Vec<char> = word.chars().collect();
                            for chunk in chars.chunks(max_length) {
                                parts.push(chunk.iter().collect());
                            }
                        } else {
                            current = word.to_string();
                        }
                    } else {
                        current.push_str(&word_with_space);
                    }
                }
            } else {
                current = line.to_string();
            }
        } else {
            current.push_str(&line_with_newline);
        }
    }

    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_message_short() {
        let msg = "Hello, world!";
        let parts = split_message(msg, MAX_DM_LENGTH);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], msg);
    }

    #[test]
    fn test_split_message_long() {
        let msg = "a".repeat(MAX_DM_LENGTH + 500);
        let parts = split_message(&msg, MAX_DM_LENGTH);
        assert!(parts.len() > 1);
        for part in &parts {
            assert!(part.len() <= MAX_DM_LENGTH);
        }
    }

    #[test]
    fn test_service_creation() {
        let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
        let service = InstagramService::new(config);
        assert_eq!(service.config().username, "testuser");
    }

    #[tokio::test]
    async fn test_service_not_running_initially() {
        let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
        let service = InstagramService::new(config);
        assert!(!service.is_running().await);
    }
}
