use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::client::MattermostClient;
use crate::config::MattermostConfig;
use crate::error::{MattermostError, Result};
use crate::types::{
    ChannelKind, MattermostChannel, MattermostEventType, MattermostMessagePayload,
    MattermostPost, MattermostUser,
};

/// Maximum message length for Mattermost posts.
pub const MAX_MESSAGE_LENGTH: usize = 16383;

/// Callback invoked when the service emits an event.
pub type EventCallback = Box<dyn Fn(MattermostEventType, serde_json::Value) + Send + Sync>;

#[derive(Default)]
struct ServiceState {
    is_running: bool,
    event_callback: Option<EventCallback>,
    bot_user: Option<MattermostUser>,
}

/// Native Mattermost service.
pub struct MattermostService {
    config: MattermostConfig,
    state: Arc<RwLock<ServiceState>>,
    client: Option<MattermostClient>,
}

impl MattermostService {
    /// Creates a new service from a validated config.
    pub fn new(config: MattermostConfig) -> Self {
        Self {
            config,
            state: Arc::new(RwLock::new(ServiceState::default())),
            client: None,
        }
    }

    /// Returns the service configuration.
    pub fn config(&self) -> &MattermostConfig {
        &self.config
    }

    /// Returns whether the service is currently running.
    pub async fn is_running(&self) -> bool {
        self.state.read().await.is_running
    }

    /// Returns the bot user once the service has started.
    pub async fn bot_user(&self) -> Option<MattermostUser> {
        self.state.read().await.bot_user.clone()
    }

    /// Returns the bot username.
    pub async fn bot_username(&self) -> Option<String> {
        self.state
            .read()
            .await
            .bot_user
            .as_ref()
            .and_then(|u| u.username.clone())
    }

    /// Sets a callback invoked for each emitted event.
    pub fn set_event_callback<F>(&mut self, callback: F)
    where
        F: Fn(MattermostEventType, serde_json::Value) + Send + Sync + 'static,
    {
        if let Ok(mut state) = self.state.try_write() {
            state.event_callback = Some(Box::new(callback));
        }
    }

    /// Starts the Mattermost service.
    pub async fn start(&mut self) -> Result<()> {
        {
            let state = self.state.read().await;
            if state.is_running {
                return Err(MattermostError::AlreadyRunning);
            }
        }

        if !self.config.enabled {
            info!("Mattermost service is disabled");
            return Ok(());
        }

        self.config.validate()?;

        info!("Starting Mattermost service...");

        let client = MattermostClient::new(&self.config.server_url, &self.config.bot_token)?;

        let bot_user = client
            .get_me()
            .await
            .map_err(|e| MattermostError::ConnectionFailed(e.to_string()))?;

        info!(
            "Mattermost connected as @{}",
            bot_user.username.as_deref().unwrap_or(&bot_user.id)
        );

        self.client = Some(client);

        {
            let mut state = self.state.write().await;
            state.is_running = true;
            state.bot_user = Some(bot_user.clone());

            if let Some(ref callback) = state.event_callback {
                callback(
                    MattermostEventType::WorldConnected,
                    serde_json::json!({
                        "bot_id": bot_user.id,
                        "bot_username": bot_user.username,
                        "bot_name": bot_user.display_name()
                    }),
                );
            }
        }

        info!("Mattermost service started successfully");
        Ok(())
    }

    /// Stops the Mattermost service.
    pub async fn stop(&mut self) -> Result<()> {
        info!("Stopping Mattermost service...");

        self.client = None;

        {
            let mut state = self.state.write().await;
            state.is_running = false;
        }

        info!("Mattermost service stopped");
        Ok(())
    }

    /// Sends a message to the given channel ID.
    pub async fn send_message(
        &self,
        channel_id: &str,
        text: &str,
        root_id: Option<&str>,
    ) -> Result<MattermostPost> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        let parts = split_message(text);

        let mut last_post: Option<MattermostPost> = None;
        for (i, part) in parts.iter().enumerate() {
            let post = client
                .create_post(crate::client::CreatePostParams {
                    channel_id,
                    message: part,
                    root_id: if i == 0 { root_id } else { None },
                    file_ids: None,
                    props: None,
                })
                .await?;
            last_post = Some(post);
        }

        last_post.ok_or_else(|| {
            MattermostError::InvalidArgument("No message content provided".to_string())
        })
    }

    /// Sends a message to a user (creates DM channel if needed).
    pub async fn send_dm(&self, user_id: &str, text: &str) -> Result<MattermostPost> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        let bot_user = self.bot_user().await.ok_or(MattermostError::ClientNotInitialized)?;

        let channel = client
            .create_direct_channel(&[bot_user.id, user_id.to_string()])
            .await?;

        self.send_message(&channel.id, text, None).await
    }

    /// Updates an existing message.
    pub async fn update_message(&self, post_id: &str, text: &str) -> Result<MattermostPost> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        client.update_post(post_id, text).await
    }

    /// Deletes a message.
    pub async fn delete_message(&self, post_id: &str) -> Result<()> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        client.delete_post(post_id).await
    }

    /// Fetches channel information.
    pub async fn get_channel(&self, channel_id: &str) -> Result<MattermostChannel> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        client.get_channel(channel_id).await
    }

    /// Fetches user information.
    pub async fn get_user(&self, user_id: &str) -> Result<MattermostUser> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        client.get_user(user_id).await
    }

    /// Sends a typing indicator.
    pub async fn send_typing(&self, channel_id: &str, parent_id: Option<&str>) -> Result<()> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        client.send_typing(channel_id, parent_id).await
    }

    /// Process an incoming post (typically from WebSocket).
    pub async fn process_incoming_post(&self, post: MattermostPost) -> Result<()> {
        let client = self
            .client
            .as_ref()
            .ok_or(MattermostError::ClientNotInitialized)?;

        let bot_user = self.bot_user().await.ok_or(MattermostError::ClientNotInitialized)?;

        // Ignore own messages
        if post.user_id.as_ref() == Some(&bot_user.id) {
            return Ok(());
        }

        // Ignore system posts
        if post.is_system_post() {
            return Ok(());
        }

        let channel_id = post.channel_id.as_ref().ok_or_else(|| {
            MattermostError::InvalidArgument("Post missing channel_id".to_string())
        })?;

        // Fetch channel info
        let channel = client.get_channel(channel_id).await?;
        let kind = channel.kind();

        // Fetch sender info
        let sender = if let Some(user_id) = &post.user_id {
            client.get_user(user_id).await.ok()
        } else {
            None
        };

        // Check policies
        if !self.should_process_message(kind, &post, sender.as_ref()) {
            return Ok(());
        }

        // Check mention requirement for channels
        let raw_text = post.message_text();
        if kind != ChannelKind::Dm && self.config.require_mention {
            if let Some(bot_username) = &bot_user.username {
                let mention = format!("@{}", bot_username);
                if !raw_text.to_lowercase().contains(&mention.to_lowercase()) {
                    return Ok(());
                }
            }
        }

        // Ignore bot messages if configured
        if self.config.ignore_bot_messages {
            if let Some(ref s) = sender {
                if s.is_bot {
                    return Ok(());
                }
            }
        }

        // Emit event
        let payload = MattermostMessagePayload {
            post: post.clone(),
            channel,
            user: sender,
            team: None,
        };

        let state = self.state.read().await;
        if let Some(ref callback) = state.event_callback {
            callback(
                MattermostEventType::MessageReceived,
                serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
            );
        }

        Ok(())
    }

    fn should_process_message(
        &self,
        kind: ChannelKind,
        post: &MattermostPost,
        sender: Option<&MattermostUser>,
    ) -> bool {
        let user_id = post.user_id.as_deref().unwrap_or("");
        let username = sender.and_then(|s| s.username.as_deref());

        match kind {
            ChannelKind::Dm => match self.config.dm_policy {
                crate::config::DmPolicy::Disabled => false,
                crate::config::DmPolicy::Open => true,
                crate::config::DmPolicy::Allowlist | crate::config::DmPolicy::Pairing => {
                    self.config.is_user_allowed(user_id, username)
                }
            },
            ChannelKind::Group | ChannelKind::Channel => match self.config.group_policy {
                crate::config::GroupPolicy::Disabled => false,
                crate::config::GroupPolicy::Open => true,
                crate::config::GroupPolicy::Allowlist => {
                    self.config.is_user_allowed(user_id, username)
                }
            },
        }
    }
}

/// Splits a message into chunks that are each at most MAX_MESSAGE_LENGTH bytes.
pub fn split_message(content: &str) -> Vec<String> {
    if content.len() <= MAX_MESSAGE_LENGTH {
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

        if current.len() + line_with_newline.len() > MAX_MESSAGE_LENGTH {
            if !current.is_empty() {
                parts.push(current);
                current = String::new();
            }

            if line.len() > MAX_MESSAGE_LENGTH {
                // Split long lines by words
                let words: Vec<&str> = line.split_whitespace().collect();
                for word in words {
                    let word_with_space = if current.is_empty() {
                        word.to_string()
                    } else {
                        format!(" {}", word)
                    };

                    if current.len() + word_with_space.len() > MAX_MESSAGE_LENGTH {
                        if !current.is_empty() {
                            parts.push(current);
                            current = String::new();
                        }

                        if word.len() > MAX_MESSAGE_LENGTH {
                            // Split very long words by characters
                            let chars: Vec<char> = word.chars().collect();
                            for chunk in chars.chunks(MAX_MESSAGE_LENGTH) {
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
        let parts = split_message(msg);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], msg);
    }

    #[test]
    fn test_split_message_long() {
        let msg = "a".repeat(MAX_MESSAGE_LENGTH + 500);
        let parts = split_message(&msg);
        assert!(parts.len() > 1);
        for part in &parts {
            assert!(part.len() <= MAX_MESSAGE_LENGTH);
        }
    }

    #[test]
    fn test_service_creation() {
        let config = MattermostConfig::new(
            "https://chat.example.com".to_string(),
            "bot_token".to_string(),
        );
        let service = MattermostService::new(config);
        assert_eq!(service.config().server_url, "https://chat.example.com");
    }
}
