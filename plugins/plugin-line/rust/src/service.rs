//! LINE service implementation for elizaOS.

use crate::types::*;
use crate::webhook::{self, WebhookEvent};
use reqwest::Client;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

const LINE_API_BASE: &str = "https://api.line.me/v2";

/// LINE messaging service for elizaOS agents
pub struct LineService {
    settings: Arc<RwLock<Option<LineSettings>>>,
    client: Client,
    connected: Arc<RwLock<bool>>,
}

impl LineService {
    /// Create a new LINE service
    pub fn new() -> Self {
        Self {
            settings: Arc::new(RwLock::new(None)),
            client: Client::new(),
            connected: Arc::new(RwLock::new(false)),
        }
    }

    /// Start the service
    pub async fn start(&self, config: &LineServiceConfig) -> Result<(), LinePluginError> {
        info!("Starting LINE service...");

        // Load settings
        let settings = self.load_settings(config)?;
        self.validate_settings(&settings)?;

        // Store settings
        *self.settings.write().await = Some(settings);
        *self.connected.write().await = true;

        info!("LINE service started");

        Ok(())
    }

    /// Stop the service
    pub async fn stop(&self) {
        info!("Stopping LINE service...");
        *self.connected.write().await = false;
        *self.settings.write().await = None;
        info!("LINE service stopped");
    }

    /// Check if the service is connected
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// Get bot info
    pub async fn get_bot_info(&self) -> Result<LineUser, LinePluginError> {
        let settings = self.settings.read().await;
        let settings = settings.as_ref().ok_or(LinePluginError::NotInitialized)?;

        let response = self
            .client
            .get(&format!("{}/bot/info", LINE_API_BASE))
            .bearer_auth(&settings.channel_access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(LinePluginError::api_with_status(
                "Failed to get bot info",
                response.status().as_u16(),
            ));
        }

        let info: serde_json::Value = response.json().await?;

        Ok(LineUser {
            user_id: info["userId"].as_str().unwrap_or_default().to_string(),
            display_name: info["displayName"].as_str().unwrap_or_default().to_string(),
            picture_url: info["pictureUrl"].as_str().map(String::from),
            status_message: None,
            language: None,
        })
    }

    /// Send a text message
    pub async fn send_message(&self, to: &str, text: &str) -> LineSendResult {
        let settings_guard = self.settings.read().await;
        let settings = match settings_guard.as_ref() {
            Some(s) => s,
            None => return LineSendResult::failure("Service not initialized"),
        };

        let chunks = split_message_for_line(text, None);
        let messages: Vec<serde_json::Value> = chunks
            .iter()
            .map(|chunk| {
                serde_json::json!({
                    "type": "text",
                    "text": chunk
                })
            })
            .collect();

        self.push_messages_internal(to, &messages, &settings.channel_access_token)
            .await
    }

    /// Send a flex message
    pub async fn send_flex_message(&self, to: &str, flex: LineFlexMessage) -> LineSendResult {
        let settings_guard = self.settings.read().await;
        let settings = match settings_guard.as_ref() {
            Some(s) => s,
            None => return LineSendResult::failure("Service not initialized"),
        };

        let message = serde_json::json!({
            "type": "flex",
            "altText": &flex.alt_text[..flex.alt_text.len().min(400)],
            "contents": flex.contents
        });

        self.push_messages_internal(to, &[message], &settings.channel_access_token)
            .await
    }

    /// Send a template message
    pub async fn send_template_message(
        &self,
        to: &str,
        template: LineTemplateMessage,
    ) -> LineSendResult {
        let settings_guard = self.settings.read().await;
        let settings = match settings_guard.as_ref() {
            Some(s) => s,
            None => return LineSendResult::failure("Service not initialized"),
        };

        let message = serde_json::json!({
            "type": "template",
            "altText": &template.alt_text[..template.alt_text.len().min(400)],
            "template": template.template
        });

        self.push_messages_internal(to, &[message], &settings.channel_access_token)
            .await
    }

    /// Send a location message
    pub async fn send_location_message(
        &self,
        to: &str,
        location: LineLocationMessage,
    ) -> LineSendResult {
        let settings_guard = self.settings.read().await;
        let settings = match settings_guard.as_ref() {
            Some(s) => s,
            None => return LineSendResult::failure("Service not initialized"),
        };

        let message = serde_json::json!({
            "type": "location",
            "title": &location.title[..location.title.len().min(100)],
            "address": &location.address[..location.address.len().min(100)],
            "latitude": location.latitude,
            "longitude": location.longitude
        });

        self.push_messages_internal(to, &[message], &settings.channel_access_token)
            .await
    }

    /// Get user profile
    pub async fn get_user_profile(&self, user_id: &str) -> Result<LineUser, LinePluginError> {
        let settings = self.settings.read().await;
        let settings = settings.as_ref().ok_or(LinePluginError::NotInitialized)?;

        let response = self
            .client
            .get(&format!("{}/bot/profile/{}", LINE_API_BASE, user_id))
            .bearer_auth(&settings.channel_access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(LinePluginError::api_with_status(
                "Failed to get user profile",
                response.status().as_u16(),
            ));
        }

        let profile: serde_json::Value = response.json().await?;

        Ok(LineUser {
            user_id: profile["userId"].as_str().unwrap_or_default().to_string(),
            display_name: profile["displayName"].as_str().unwrap_or_default().to_string(),
            picture_url: profile["pictureUrl"].as_str().map(String::from),
            status_message: profile["statusMessage"].as_str().map(String::from),
            language: profile["language"].as_str().map(String::from),
        })
    }

    /// Get group info
    pub async fn get_group_info(&self, group_id: &str) -> Result<LineGroup, LinePluginError> {
        let settings = self.settings.read().await;
        let settings = settings.as_ref().ok_or(LinePluginError::NotInitialized)?;

        let chat_type = get_chat_type_from_id(group_id);

        if chat_type == Some(LineChatType::Group) {
            let response = self
                .client
                .get(&format!("{}/bot/group/{}/summary", LINE_API_BASE, group_id))
                .bearer_auth(&settings.channel_access_token)
                .send()
                .await?;

            if !response.status().is_success() {
                return Err(LinePluginError::api_with_status(
                    "Failed to get group info",
                    response.status().as_u16(),
                ));
            }

            let summary: serde_json::Value = response.json().await?;

            Ok(LineGroup {
                group_id: summary["groupId"].as_str().unwrap_or(group_id).to_string(),
                group_type: LineChatType::Group,
                group_name: summary["groupName"].as_str().map(String::from),
                picture_url: summary["pictureUrl"].as_str().map(String::from),
                member_count: None,
            })
        } else if chat_type == Some(LineChatType::Room) {
            Ok(LineGroup {
                group_id: group_id.to_string(),
                group_type: LineChatType::Room,
                group_name: None,
                picture_url: None,
                member_count: None,
            })
        } else {
            Err(LinePluginError::api("Invalid group/room ID"))
        }
    }

    /// Leave a group or room
    pub async fn leave_chat(
        &self,
        chat_id: &str,
        chat_type: LineChatType,
    ) -> Result<(), LinePluginError> {
        let settings = self.settings.read().await;
        let settings = settings.as_ref().ok_or(LinePluginError::NotInitialized)?;

        let endpoint = match chat_type {
            LineChatType::Group => format!("{}/bot/group/{}/leave", LINE_API_BASE, chat_id),
            LineChatType::Room => format!("{}/bot/room/{}/leave", LINE_API_BASE, chat_id),
            _ => return Err(LinePluginError::api("Cannot leave a user chat")),
        };

        let response = self
            .client
            .post(&endpoint)
            .bearer_auth(&settings.channel_access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(LinePluginError::api_with_status(
                "Failed to leave chat",
                response.status().as_u16(),
            ));
        }

        Ok(())
    }

    // Webhook support

    /// Get the channel secret for webhook validation.
    pub async fn get_channel_secret(&self) -> Option<String> {
        self.settings
            .read()
            .await
            .as_ref()
            .map(|s| s.channel_secret.clone())
    }

    /// Validate a webhook request signature.
    pub async fn validate_webhook_signature(&self, body: &[u8], signature: &str) -> bool {
        match self.get_channel_secret().await {
            Some(secret) => webhook::validate_signature(body, signature, &secret),
            None => false,
        }
    }

    /// Parse and handle webhook events from a raw body.
    pub fn parse_webhook_events(
        &self,
        body: &serde_json::Value,
    ) -> Vec<WebhookEvent> {
        webhook::parse_webhook_body(body)
    }

    /// Handle parsed webhook events (logs each event type).
    pub async fn handle_webhook_events(&self, events: &[WebhookEvent]) {
        for event in events {
            self.handle_webhook_event(event).await;
        }
    }

    async fn handle_webhook_event(&self, event: &WebhookEvent) {
        match event {
            WebhookEvent::Follow(e) => {
                debug!("Follow event from user: {:?}", e.source.user_id);
            }
            WebhookEvent::Unfollow(e) => {
                debug!("Unfollow event from user: {:?}", e.source.user_id);
            }
            WebhookEvent::Join(e) => {
                debug!(
                    "Join event for: {:?}",
                    e.source.group_id.as_ref().or(e.source.room_id.as_ref())
                );
            }
            WebhookEvent::Leave(e) => {
                debug!(
                    "Leave event for: {:?}",
                    e.source.group_id.as_ref().or(e.source.room_id.as_ref())
                );
            }
            WebhookEvent::Postback(e) => {
                debug!("Postback event: data={}", e.data);
            }
            WebhookEvent::Message(e) => {
                debug!(
                    "Message event: id={}, type={}",
                    e.message_id, e.message_type
                );
            }
        }
    }

    // Private methods

    fn load_settings(&self, config: &LineServiceConfig) -> Result<LineSettings, LinePluginError> {
        Ok(LineSettings {
            channel_access_token: config.channel_access_token.clone(),
            channel_secret: config.channel_secret.clone(),
            webhook_path: config
                .webhook_path
                .clone()
                .unwrap_or_else(|| "/webhooks/line".to_string()),
            dm_policy: config
                .dm_policy
                .clone()
                .unwrap_or_else(|| "pairing".to_string()),
            group_policy: config
                .group_policy
                .clone()
                .unwrap_or_else(|| "allowlist".to_string()),
            allow_from: config.allow_from.clone(),
            enabled: config.enabled,
        })
    }

    fn validate_settings(&self, settings: &LineSettings) -> Result<(), LinePluginError> {
        if settings.channel_access_token.is_empty() {
            return Err(LinePluginError::configuration_with_setting(
                "LINE_CHANNEL_ACCESS_TOKEN is required",
                "LINE_CHANNEL_ACCESS_TOKEN",
            ));
        }

        if settings.channel_secret.is_empty() {
            return Err(LinePluginError::configuration_with_setting(
                "LINE_CHANNEL_SECRET is required",
                "LINE_CHANNEL_SECRET",
            ));
        }

        Ok(())
    }

    async fn push_messages_internal(
        &self,
        to: &str,
        messages: &[serde_json::Value],
        token: &str,
    ) -> LineSendResult {
        // Send in batches of 5
        for batch in messages.chunks(MAX_LINE_BATCH_SIZE) {
            let body = serde_json::json!({
                "to": to,
                "messages": batch
            });

            let response = match self
                .client
                .post(&format!("{}/bot/message/push", LINE_API_BASE))
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => return LineSendResult::failure(format!("HTTP error: {}", e)),
            };

            if !response.status().is_success() {
                return LineSendResult::failure(format!(
                    "API error: status {}",
                    response.status().as_u16()
                ));
            }
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();

        LineSendResult::success(timestamp.to_string(), to.to_string())
    }
}

impl Default for LineService {
    fn default() -> Self {
        Self::new()
    }
}

/// Configuration for the LINE service
#[derive(Debug, Clone)]
pub struct LineServiceConfig {
    pub channel_access_token: String,
    pub channel_secret: String,
    pub webhook_path: Option<String>,
    pub dm_policy: Option<String>,
    pub group_policy: Option<String>,
    pub allow_from: Vec<String>,
    pub enabled: bool,
}

impl Default for LineServiceConfig {
    fn default() -> Self {
        Self {
            channel_access_token: String::new(),
            channel_secret: String::new(),
            webhook_path: Some("/webhooks/line".to_string()),
            dm_policy: Some("pairing".to_string()),
            group_policy: Some("allowlist".to_string()),
            allow_from: Vec::new(),
            enabled: true,
        }
    }
}
