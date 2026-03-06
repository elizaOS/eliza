//! Slack service implementation for elizaOS.

use crate::types::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

/// Slack API base URL
const SLACK_API_BASE: &str = "https://slack.com/api";

/// Slack service for interacting with Slack APIs
pub struct SlackService {
    client: Client,
    bot_token: String,
    app_token: Option<String>,
    user_token: Option<String>,
    bot_user_id: Option<String>,
    team_id: Option<String>,
    settings: SlackSettings,
    allowed_channel_ids: HashSet<String>,
    dynamic_channel_ids: Arc<RwLock<HashSet<String>>>,
    user_cache: Arc<RwLock<HashMap<String, SlackUser>>>,
    channel_cache: Arc<RwLock<HashMap<String, SlackChannel>>>,
    is_connected: bool,
}

impl SlackService {
    /// Create a new Slack service instance
    pub async fn new(
        bot_token: String,
        app_token: Option<String>,
        user_token: Option<String>,
        settings: SlackSettings,
    ) -> Result<Self, SlackError> {
        let client = Client::new();
        
        let mut allowed_channel_ids = HashSet::new();
        if let Some(ref ids) = settings.allowed_channel_ids {
            for id in ids {
                if is_valid_channel_id(id) {
                    allowed_channel_ids.insert(id.clone());
                }
            }
        }
        
        let mut service = Self {
            client,
            bot_token,
            app_token,
            user_token,
            bot_user_id: None,
            team_id: None,
            settings,
            allowed_channel_ids,
            dynamic_channel_ids: Arc::new(RwLock::new(HashSet::new())),
            user_cache: Arc::new(RwLock::new(HashMap::new())),
            channel_cache: Arc::new(RwLock::new(HashMap::new())),
            is_connected: false,
        };
        
        // Authenticate and get bot info
        service.authenticate().await?;
        
        Ok(service)
    }
    
    /// Authenticate with Slack and get bot information
    async fn authenticate(&mut self) -> Result<(), SlackError> {
        let response = self
            .client
            .post(&format!("{}/auth.test", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .send()
            .await?;
        
        let auth_response: AuthTestResponse = response.json().await?;
        
        if !auth_response.ok {
            return Err(SlackError::ApiError {
                message: auth_response.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        self.bot_user_id = auth_response.user_id;
        self.team_id = auth_response.team_id;
        self.is_connected = true;
        
        info!(
            "Slack bot authenticated: user_id={:?}, team_id={:?}",
            self.bot_user_id, self.team_id
        );
        
        Ok(())
    }
    
    /// Check if a channel is allowed
    pub fn is_channel_allowed(&self, channel_id: &str) -> bool {
        if self.allowed_channel_ids.is_empty() {
            return true;
        }
        self.allowed_channel_ids.contains(channel_id)
    }
    
    /// Get the bot user ID
    pub fn bot_user_id(&self) -> Option<&str> {
        self.bot_user_id.as_deref()
    }
    
    /// Get the team ID
    pub fn team_id(&self) -> Option<&str> {
        self.team_id.as_deref()
    }
    
    /// Check if the service is connected
    pub fn is_connected(&self) -> bool {
        self.is_connected
    }
    
    /// Send a message to a channel
    pub async fn send_message(
        &self,
        channel_id: &str,
        text: &str,
        options: Option<SlackMessageSendOptions>,
    ) -> Result<SendMessageResult, SlackError> {
        let options = options.unwrap_or_default();
        
        // Split message if too long
        let messages = self.split_message(text);
        let mut last_ts = String::new();
        
        for msg in messages {
            let request = ChatPostMessageRequest {
                channel: channel_id.to_string(),
                text: msg,
                thread_ts: options.thread_ts.clone(),
                reply_broadcast: options.reply_broadcast,
                unfurl_links: options.unfurl_links,
                unfurl_media: options.unfurl_media,
                mrkdwn: options.mrkdwn.unwrap_or(true),
            };
            
            let response = self
                .client
                .post(&format!("{}/chat.postMessage", SLACK_API_BASE))
                .bearer_auth(&self.bot_token)
                .json(&request)
                .send()
                .await?;
            
            let result: ChatPostMessageResponse = response.json().await?;
            
            if !result.ok {
                return Err(SlackError::ApiError {
                    message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                    code: None,
                });
            }
            
            last_ts = result.ts.unwrap_or_default();
        }
        
        Ok(SendMessageResult {
            ts: last_ts,
            channel_id: channel_id.to_string(),
        })
    }
    
    /// Add a reaction to a message
    pub async fn add_reaction(
        &self,
        channel_id: &str,
        message_ts: &str,
        emoji: &str,
    ) -> Result<(), SlackError> {
        let clean_emoji = emoji.trim_matches(':');
        
        let request = ReactionsAddRequest {
            channel: channel_id.to_string(),
            timestamp: message_ts.to_string(),
            name: clean_emoji.to_string(),
        };
        
        let response = self
            .client
            .post(&format!("{}/reactions.add", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .json(&request)
            .send()
            .await?;
        
        let result: ApiResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(())
    }
    
    /// Remove a reaction from a message
    pub async fn remove_reaction(
        &self,
        channel_id: &str,
        message_ts: &str,
        emoji: &str,
    ) -> Result<(), SlackError> {
        let clean_emoji = emoji.trim_matches(':');
        
        let request = ReactionsRemoveRequest {
            channel: channel_id.to_string(),
            timestamp: message_ts.to_string(),
            name: clean_emoji.to_string(),
        };
        
        let response = self
            .client
            .post(&format!("{}/reactions.remove", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .json(&request)
            .send()
            .await?;
        
        let result: ApiResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(())
    }
    
    /// Edit a message
    pub async fn edit_message(
        &self,
        channel_id: &str,
        message_ts: &str,
        text: &str,
    ) -> Result<(), SlackError> {
        let request = ChatUpdateRequest {
            channel: channel_id.to_string(),
            ts: message_ts.to_string(),
            text: text.to_string(),
        };
        
        let response = self
            .client
            .post(&format!("{}/chat.update", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .json(&request)
            .send()
            .await?;
        
        let result: ApiResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(())
    }
    
    /// Delete a message
    pub async fn delete_message(
        &self,
        channel_id: &str,
        message_ts: &str,
    ) -> Result<(), SlackError> {
        let request = ChatDeleteRequest {
            channel: channel_id.to_string(),
            ts: message_ts.to_string(),
        };
        
        let response = self
            .client
            .post(&format!("{}/chat.delete", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .json(&request)
            .send()
            .await?;
        
        let result: ApiResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(())
    }
    
    /// Pin a message
    pub async fn pin_message(
        &self,
        channel_id: &str,
        message_ts: &str,
    ) -> Result<(), SlackError> {
        let request = PinsAddRequest {
            channel: channel_id.to_string(),
            timestamp: message_ts.to_string(),
        };
        
        let response = self
            .client
            .post(&format!("{}/pins.add", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .json(&request)
            .send()
            .await?;
        
        let result: ApiResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(())
    }
    
    /// Unpin a message
    pub async fn unpin_message(
        &self,
        channel_id: &str,
        message_ts: &str,
    ) -> Result<(), SlackError> {
        let request = PinsRemoveRequest {
            channel: channel_id.to_string(),
            timestamp: message_ts.to_string(),
        };
        
        let response = self
            .client
            .post(&format!("{}/pins.remove", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .json(&request)
            .send()
            .await?;
        
        let result: ApiResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(())
    }
    
    /// Get user information
    pub async fn get_user(&self, user_id: &str) -> Result<SlackUser, SlackError> {
        // Check cache first
        {
            let cache = self.user_cache.read().await;
            if let Some(user) = cache.get(user_id) {
                return Ok(user.clone());
            }
        }
        
        let response = self
            .client
            .get(&format!("{}/users.info", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .query(&[("user", user_id)])
            .send()
            .await?;
        
        let result: UsersInfoResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        let user = result.user.ok_or_else(|| SlackError::ApiError {
            message: "User not found".to_string(),
            code: None,
        })?;
        
        // Cache the user
        {
            let mut cache = self.user_cache.write().await;
            cache.insert(user_id.to_string(), user.clone());
        }
        
        Ok(user)
    }
    
    /// Get channel information
    pub async fn get_channel(&self, channel_id: &str) -> Result<SlackChannel, SlackError> {
        // Check cache first
        {
            let cache = self.channel_cache.read().await;
            if let Some(channel) = cache.get(channel_id) {
                return Ok(channel.clone());
            }
        }
        
        let response = self
            .client
            .get(&format!("{}/conversations.info", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .query(&[("channel", channel_id)])
            .send()
            .await?;
        
        let result: ConversationsInfoResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        let channel = result.channel.ok_or_else(|| SlackError::ApiError {
            message: "Channel not found".to_string(),
            code: None,
        })?;
        
        // Cache the channel
        {
            let mut cache = self.channel_cache.write().await;
            cache.insert(channel_id.to_string(), channel.clone());
        }
        
        Ok(channel)
    }
    
    /// List channels
    pub async fn list_channels(
        &self,
        types: Option<&str>,
        limit: Option<i32>,
    ) -> Result<Vec<SlackChannel>, SlackError> {
        let types = types.unwrap_or("public_channel,private_channel");
        let limit = limit.unwrap_or(1000);
        
        let response = self
            .client
            .get(&format!("{}/conversations.list", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .query(&[("types", types), ("limit", &limit.to_string())])
            .send()
            .await?;
        
        let result: ConversationsListResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(result.channels.unwrap_or_default())
    }
    
    /// Read channel history
    pub async fn read_history(
        &self,
        channel_id: &str,
        limit: Option<i32>,
        before: Option<&str>,
        after: Option<&str>,
    ) -> Result<Vec<SlackMessage>, SlackError> {
        let limit = limit.unwrap_or(100);
        
        let mut query = vec![
            ("channel", channel_id.to_string()),
            ("limit", limit.to_string()),
        ];
        
        if let Some(before) = before {
            query.push(("latest", before.to_string()));
        }
        
        if let Some(after) = after {
            query.push(("oldest", after.to_string()));
        }
        
        let response = self
            .client
            .get(&format!("{}/conversations.history", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .query(&query)
            .send()
            .await?;
        
        let result: ConversationsHistoryResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(result.messages.unwrap_or_default())
    }
    
    /// Get custom emoji list
    pub async fn get_emoji_list(&self) -> Result<HashMap<String, String>, SlackError> {
        let response = self
            .client
            .get(&format!("{}/emoji.list", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .send()
            .await?;
        
        let result: EmojiListResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        Ok(result.emoji.unwrap_or_default())
    }
    
    /// List pinned messages
    pub async fn list_pins(&self, channel_id: &str) -> Result<Vec<SlackMessage>, SlackError> {
        let response = self
            .client
            .get(&format!("{}/pins.list", SLACK_API_BASE))
            .bearer_auth(&self.bot_token)
            .query(&[("channel", channel_id)])
            .send()
            .await?;
        
        let result: PinsListResponse = response.json().await?;
        
        if !result.ok {
            return Err(SlackError::ApiError {
                message: result.error.unwrap_or_else(|| "Unknown error".to_string()),
                code: None,
            });
        }
        
        let messages = result
            .items
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.message)
            .collect();
        
        Ok(messages)
    }
    
    /// Split a message into chunks if it exceeds the max length
    fn split_message(&self, text: &str) -> Vec<String> {
        if text.len() <= MAX_SLACK_MESSAGE_LENGTH {
            return vec![text.to_string()];
        }
        
        let mut messages = Vec::new();
        let mut remaining = text;
        
        while !remaining.is_empty() {
            if remaining.len() <= MAX_SLACK_MESSAGE_LENGTH {
                messages.push(remaining.to_string());
                break;
            }
            
            let mut split_index = MAX_SLACK_MESSAGE_LENGTH;
            
            // Try to split at newline
            if let Some(last_newline) = remaining[..MAX_SLACK_MESSAGE_LENGTH].rfind('\n') {
                if last_newline > MAX_SLACK_MESSAGE_LENGTH / 2 {
                    split_index = last_newline + 1;
                }
            } else if let Some(last_space) = remaining[..MAX_SLACK_MESSAGE_LENGTH].rfind(' ') {
                if last_space > MAX_SLACK_MESSAGE_LENGTH / 2 {
                    split_index = last_space + 1;
                }
            }
            
            messages.push(remaining[..split_index].to_string());
            remaining = &remaining[split_index..];
        }
        
        messages
    }
    
    /// Clear the user cache
    pub async fn clear_user_cache(&self) {
        let mut cache = self.user_cache.write().await;
        cache.clear();
    }
    
    /// Clear the channel cache
    pub async fn clear_channel_cache(&self) {
        let mut cache = self.channel_cache.write().await;
        cache.clear();
    }
}

/// Result of sending a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub ts: String,
    pub channel_id: String,
}

// API request/response types

#[derive(Debug, Serialize)]
struct ChatPostMessageRequest {
    channel: String,
    text: String,
    thread_ts: Option<String>,
    reply_broadcast: Option<bool>,
    unfurl_links: Option<bool>,
    unfurl_media: Option<bool>,
    mrkdwn: bool,
}

#[derive(Debug, Deserialize)]
struct ChatPostMessageResponse {
    ok: bool,
    ts: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatUpdateRequest {
    channel: String,
    ts: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct ChatDeleteRequest {
    channel: String,
    ts: String,
}

#[derive(Debug, Serialize)]
struct ReactionsAddRequest {
    channel: String,
    timestamp: String,
    name: String,
}

#[derive(Debug, Serialize)]
struct ReactionsRemoveRequest {
    channel: String,
    timestamp: String,
    name: String,
}

#[derive(Debug, Serialize)]
struct PinsAddRequest {
    channel: String,
    timestamp: String,
}

#[derive(Debug, Serialize)]
struct PinsRemoveRequest {
    channel: String,
    timestamp: String,
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthTestResponse {
    ok: bool,
    user_id: Option<String>,
    team_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UsersInfoResponse {
    ok: bool,
    user: Option<SlackUser>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConversationsInfoResponse {
    ok: bool,
    channel: Option<SlackChannel>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConversationsListResponse {
    ok: bool,
    channels: Option<Vec<SlackChannel>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConversationsHistoryResponse {
    ok: bool,
    messages: Option<Vec<SlackMessage>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EmojiListResponse {
    ok: bool,
    emoji: Option<HashMap<String, String>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PinsListResponse {
    ok: bool,
    items: Option<Vec<PinItem>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PinItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    message: Option<SlackMessage>,
}
