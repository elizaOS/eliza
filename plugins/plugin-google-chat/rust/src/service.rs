//! Google Chat service implementation for elizaOS.

use crate::types::*;
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info};

const CHAT_API_BASE: &str = "https://chat.googleapis.com/v1";

/// Google Chat messaging service for elizaOS agents.
pub struct GoogleChatService {
    settings: GoogleChatSettings,
    client: Client,
    access_token: Arc<RwLock<Option<String>>>,
    connected: Arc<RwLock<bool>>,
    cached_spaces: Arc<RwLock<Vec<GoogleChatSpace>>>,
}

impl GoogleChatService {
    /// Create a new Google Chat service instance.
    pub async fn new(settings: GoogleChatSettings) -> Result<Self, GoogleChatError> {
        let service = Self {
            settings,
            client: Client::new(),
            access_token: Arc::new(RwLock::new(None)),
            connected: Arc::new(RwLock::new(false)),
            cached_spaces: Arc::new(RwLock::new(Vec::new())),
        };

        service.validate_settings()?;
        Ok(service)
    }

    fn validate_settings(&self) -> Result<(), GoogleChatError> {
        if self.settings.service_account.is_none() && self.settings.service_account_file.is_none() {
            if std::env::var("GOOGLE_APPLICATION_CREDENTIALS").is_err() {
                return Err(GoogleChatError::config_with_setting(
                    "Google Chat requires service account credentials",
                    "GOOGLE_CHAT_SERVICE_ACCOUNT",
                ));
            }
        }

        if self.settings.audience.is_empty() {
            return Err(GoogleChatError::config_with_setting(
                "GOOGLE_CHAT_AUDIENCE is required",
                "GOOGLE_CHAT_AUDIENCE",
            ));
        }

        Ok(())
    }

    /// Start the Google Chat service.
    pub async fn start(&self) -> Result<(), GoogleChatError> {
        // Initialize access token
        self.refresh_access_token().await?;

        // Test connection
        self.test_connection().await?;

        *self.connected.write().await = true;
        info!(
            "Google Chat service started with webhook path: {}",
            self.settings.webhook_path
        );

        Ok(())
    }

    /// Stop the Google Chat service.
    pub async fn stop(&self) {
        *self.connected.write().await = false;
        info!("Google Chat service stopped");
    }

    /// Check if connected.
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// Get the bot user name.
    pub fn get_bot_user(&self) -> Option<&str> {
        self.settings.bot_user.as_deref()
    }

    /// Get the settings.
    pub fn get_settings(&self) -> &GoogleChatSettings {
        &self.settings
    }

    /// Refresh the access token using service account credentials.
    async fn refresh_access_token(&self) -> Result<(), GoogleChatError> {
        // In production, this would use the service account to get a JWT
        // and exchange it for an access token via Google's OAuth endpoint.
        // For now, we'll store the service account token directly.
        
        // This is a simplified implementation - in production you would:
        // 1. Load the service account JSON
        // 2. Create a JWT with the proper claims
        // 3. Sign it with the private key
        // 4. Exchange it for an access token

        if let Some(ref sa) = self.settings.service_account {
            // Parse service account JSON and extract token
            // This is simplified - real implementation would generate JWT
            *self.access_token.write().await = Some(sa.clone());
        } else if let Some(ref sa_file) = self.settings.service_account_file {
            // Load from file and process
            let contents = std::fs::read_to_string(sa_file)
                .map_err(|e| GoogleChatError::config(format!("Failed to read service account file: {}", e)))?;
            *self.access_token.write().await = Some(contents);
        }

        Ok(())
    }

    /// Get an access token.
    pub async fn get_access_token(&self) -> Result<String, GoogleChatError> {
        let token = self.access_token.read().await.clone();
        token.ok_or_else(|| GoogleChatError::auth("No access token available"))
    }

    /// Test the connection to Google Chat API.
    async fn test_connection(&self) -> Result<(), GoogleChatError> {
        let token = self.get_access_token().await?;
        let url = format!("{}/spaces?pageSize=1", CHAT_API_BASE);

        let response = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(GoogleChatError::api(format!(
                "Failed to connect to Google Chat API: {}",
                text
            )));
        }

        info!("Google Chat API connection verified");
        Ok(())
    }

    /// Build a Chat API URL.
    fn api_url(&self, path: &str) -> String {
        format!("{}{}", CHAT_API_BASE, path)
    }

    /// Get spaces the bot is in.
    pub async fn get_spaces(&self) -> Result<Vec<GoogleChatSpace>, GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let token = self.get_access_token().await?;
        let url = self.api_url("/spaces");

        let response: serde_json::Value = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .send()
            .await?
            .json()
            .await?;

        let spaces: Vec<GoogleChatSpace> = response
            .get("spaces")
            .and_then(|s| s.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        Some(GoogleChatSpace {
                            name: v.get("name")?.as_str()?.to_string(),
                            display_name: v.get("displayName").and_then(|d| d.as_str()).map(String::from),
                            space_type: v.get("type").and_then(|t| t.as_str()).unwrap_or("SPACE").to_string(),
                            single_user_bot_dm: v.get("singleUserBotDm").and_then(|b| b.as_bool()).unwrap_or(false),
                            threaded: v.get("threaded").and_then(|b| b.as_bool()).unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        *self.cached_spaces.write().await = spaces.clone();
        Ok(spaces)
    }

    /// Send a message to a space.
    pub async fn send_message(
        &self,
        options: GoogleChatMessageSendOptions,
    ) -> Result<GoogleChatSendResult, GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let space = match &options.space {
            Some(s) => s.clone(),
            None => return Ok(GoogleChatSendResult::err("Space is required")),
        };

        let token = self.get_access_token().await?;

        let mut body = json!({});

        if let Some(ref text) = options.text {
            body["text"] = json!(text);
        }

        if let Some(ref thread) = options.thread {
            body["thread"] = json!({ "name": thread });
        }

        if !options.attachments.is_empty() {
            let attachments: Vec<serde_json::Value> = options
                .attachments
                .iter()
                .map(|att| {
                    let mut obj = json!({
                        "attachmentDataRef": {
                            "attachmentUploadToken": att.attachment_upload_token
                        }
                    });
                    if let Some(ref name) = att.content_name {
                        obj["contentName"] = json!(name);
                    }
                    obj
                })
                .collect();
            body["attachment"] = json!(attachments);
        }

        let url = format!("{}/{}/messages", CHAT_API_BASE, space);

        let response: serde_json::Value = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let message_name = response
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();

        debug!("Message sent to {}: {}", space, message_name);

        Ok(GoogleChatSendResult::ok(message_name, space))
    }

    /// Update a message.
    pub async fn update_message(
        &self,
        message_name: &str,
        text: &str,
    ) -> Result<GoogleChatSendResult, GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let token = self.get_access_token().await?;
        let url = format!("{}/{}?updateMask=text", CHAT_API_BASE, message_name);

        let response: serde_json::Value = self
            .client
            .patch(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .json(&json!({ "text": text }))
            .send()
            .await?
            .json()
            .await?;

        let name = response
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();

        Ok(GoogleChatSendResult {
            success: true,
            message_name: Some(name),
            space: None,
            error: None,
        })
    }

    /// Delete a message.
    pub async fn delete_message(&self, message_name: &str) -> Result<(), GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let token = self.get_access_token().await?;
        let url = format!("{}/{}", CHAT_API_BASE, message_name);

        self.client
            .delete(&url)
            .bearer_auth(&token)
            .send()
            .await?;

        Ok(())
    }

    /// Send a reaction to a message.
    pub async fn send_reaction(
        &self,
        message_name: &str,
        emoji: &str,
    ) -> Result<GoogleChatReaction, GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let token = self.get_access_token().await?;
        let url = format!("{}/{}/reactions", CHAT_API_BASE, message_name);

        let response: serde_json::Value = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .json(&json!({ "emoji": { "unicode": emoji } }))
            .send()
            .await?
            .json()
            .await?;

        Ok(GoogleChatReaction {
            name: response.get("name").and_then(|n| n.as_str()).map(String::from),
            user: None,
            emoji: Some(emoji.to_string()),
        })
    }

    /// Delete a reaction.
    pub async fn delete_reaction(&self, reaction_name: &str) -> Result<(), GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let token = self.get_access_token().await?;
        let url = format!("{}/{}", CHAT_API_BASE, reaction_name);

        self.client
            .delete(&url)
            .bearer_auth(&token)
            .send()
            .await?;

        Ok(())
    }

    /// List reactions on a message.
    pub async fn list_reactions(
        &self,
        message_name: &str,
        limit: Option<u32>,
    ) -> Result<Vec<GoogleChatReaction>, GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let token = self.get_access_token().await?;
        let mut url = format!("{}/{}/reactions", CHAT_API_BASE, message_name);
        if let Some(l) = limit {
            url.push_str(&format!("?pageSize={}", l));
        }

        let response: serde_json::Value = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .send()
            .await?
            .json()
            .await?;

        let reactions: Vec<GoogleChatReaction> = response
            .get("reactions")
            .and_then(|r| r.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        Some(GoogleChatReaction {
                            name: v.get("name").and_then(|n| n.as_str()).map(String::from),
                            user: v.get("user").map(|u| GoogleChatUser {
                                name: u.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                                display_name: u.get("displayName").and_then(|d| d.as_str()).map(String::from),
                                email: u.get("email").and_then(|e| e.as_str()).map(String::from),
                                user_type: u.get("type").and_then(|t| t.as_str()).map(String::from),
                                domain_id: None,
                                is_anonymous: false,
                            }),
                            emoji: v.get("emoji").and_then(|e| e.get("unicode")).and_then(|u| u.as_str()).map(String::from),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(reactions)
    }

    /// Find or create a DM space with a user.
    pub async fn find_direct_message(
        &self,
        user_name: &str,
    ) -> Result<Option<GoogleChatSpace>, GoogleChatError> {
        if !self.is_connected().await {
            return Err(GoogleChatError::NotConnected);
        }

        let token = self.get_access_token().await?;
        let url = format!("{}/spaces:findDirectMessage?name={}", CHAT_API_BASE, user_name);

        let response = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            return Ok(None);
        }

        let data: serde_json::Value = response.json().await?;

        Ok(Some(GoogleChatSpace {
            name: data.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
            display_name: data.get("displayName").and_then(|d| d.as_str()).map(String::from),
            space_type: data.get("type").and_then(|t| t.as_str()).unwrap_or("DM").to_string(),
            single_user_bot_dm: true,
            threaded: false,
        }))
    }
}
