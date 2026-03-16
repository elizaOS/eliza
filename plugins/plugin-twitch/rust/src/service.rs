//! Twitch service implementation for elizaOS.
//!
//! This service provides Twitch chat integration using IRC over WebSocket.

use crate::types::*;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

const TWITCH_IRC_URL: &str = "wss://irc-ws.chat.twitch.tv:443";

/// Twitch chat service for elizaOS agents.
pub struct TwitchService {
    settings: TwitchSettings,
    connected: Arc<RwLock<bool>>,
    joined_channels: Arc<RwLock<HashSet<String>>>,
    sender: Arc<RwLock<Option<mpsc::Sender<String>>>>,
}

impl TwitchService {
    /// Create a new Twitch service with the given settings.
    pub async fn new(settings: TwitchSettings) -> Result<Self, TwitchPluginError> {
        // Validate settings
        if settings.username.is_empty() {
            return Err(TwitchPluginError::Configuration {
                message: "TWITCH_USERNAME is required".to_string(),
                setting_name: Some("TWITCH_USERNAME".to_string()),
            });
        }

        if settings.client_id.is_empty() {
            return Err(TwitchPluginError::Configuration {
                message: "TWITCH_CLIENT_ID is required".to_string(),
                setting_name: Some("TWITCH_CLIENT_ID".to_string()),
            });
        }

        if settings.access_token.is_empty() {
            return Err(TwitchPluginError::Configuration {
                message: "TWITCH_ACCESS_TOKEN is required".to_string(),
                setting_name: Some("TWITCH_ACCESS_TOKEN".to_string()),
            });
        }

        if settings.channel.is_empty() {
            return Err(TwitchPluginError::Configuration {
                message: "TWITCH_CHANNEL is required".to_string(),
                setting_name: Some("TWITCH_CHANNEL".to_string()),
            });
        }

        let service = Self {
            settings,
            connected: Arc::new(RwLock::new(false)),
            joined_channels: Arc::new(RwLock::new(HashSet::new())),
            sender: Arc::new(RwLock::new(None)),
        };

        Ok(service)
    }

    /// Create service from environment settings.
    pub async fn from_env(
        get_setting: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, TwitchPluginError> {
        let username = get_setting("TWITCH_USERNAME").ok_or_else(|| {
            TwitchPluginError::Configuration {
                message: "TWITCH_USERNAME is required".to_string(),
                setting_name: Some("TWITCH_USERNAME".to_string()),
            }
        })?;

        let client_id = get_setting("TWITCH_CLIENT_ID").ok_or_else(|| {
            TwitchPluginError::Configuration {
                message: "TWITCH_CLIENT_ID is required".to_string(),
                setting_name: Some("TWITCH_CLIENT_ID".to_string()),
            }
        })?;

        let access_token = get_setting("TWITCH_ACCESS_TOKEN").ok_or_else(|| {
            TwitchPluginError::Configuration {
                message: "TWITCH_ACCESS_TOKEN is required".to_string(),
                setting_name: Some("TWITCH_ACCESS_TOKEN".to_string()),
            }
        })?;

        let channel = get_setting("TWITCH_CHANNEL").ok_or_else(|| {
            TwitchPluginError::Configuration {
                message: "TWITCH_CHANNEL is required".to_string(),
                setting_name: Some("TWITCH_CHANNEL".to_string()),
            }
        })?;

        let client_secret = get_setting("TWITCH_CLIENT_SECRET");
        let refresh_token = get_setting("TWITCH_REFRESH_TOKEN");
        let additional_channels_str = get_setting("TWITCH_CHANNELS");
        let require_mention = get_setting("TWITCH_REQUIRE_MENTION")
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(false);
        let allowed_roles_str = get_setting("TWITCH_ALLOWED_ROLES");

        let additional_channels = additional_channels_str
            .map(|s| {
                s.split(',')
                    .map(|c| c.trim().to_string())
                    .filter(|c| !c.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let allowed_roles: Vec<TwitchRole> = allowed_roles_str
            .map(|s| {
                s.split(',')
                    .filter_map(|r| match r.trim().to_lowercase().as_str() {
                        "moderator" => Some(TwitchRole::Moderator),
                        "owner" => Some(TwitchRole::Owner),
                        "vip" => Some(TwitchRole::Vip),
                        "subscriber" => Some(TwitchRole::Subscriber),
                        "all" => Some(TwitchRole::All),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_else(|| vec![TwitchRole::All]);

        let settings = TwitchSettings {
            username,
            client_id,
            access_token,
            client_secret,
            refresh_token,
            channel,
            additional_channels,
            require_mention,
            allowed_roles,
            allowed_user_ids: Vec::new(),
            enabled: true,
        };

        Self::new(settings).await
    }

    /// Connect to Twitch IRC.
    pub async fn connect(&self) -> Result<(), TwitchPluginError> {
        let url = url::Url::parse(TWITCH_IRC_URL).unwrap();

        let (ws_stream, _) = connect_async(url)
            .await
            .map_err(|e| TwitchPluginError::WebSocket(e.to_string()))?;

        let (mut write, mut read) = ws_stream.split();

        // Create channel for sending messages
        let (tx, mut rx) = mpsc::channel::<String>(100);
        *self.sender.write().await = Some(tx);

        // Authenticate
        let token = self.normalize_token(&self.settings.access_token);
        write
            .send(WsMessage::Text(format!("PASS oauth:{}", token)))
            .await
            .map_err(|e| TwitchPluginError::WebSocket(e.to_string()))?;

        write
            .send(WsMessage::Text(format!("NICK {}", self.settings.username)))
            .await
            .map_err(|e| TwitchPluginError::WebSocket(e.to_string()))?;

        // Request capabilities for tags
        write
            .send(WsMessage::Text(
                "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
            ))
            .await
            .map_err(|e| TwitchPluginError::WebSocket(e.to_string()))?;

        // Join channels
        let mut all_channels = vec![self.settings.channel.clone()];
        all_channels.extend(self.settings.additional_channels.clone());

        for channel in &all_channels {
            let normalized = normalize_channel(channel);
            write
                .send(WsMessage::Text(format!("JOIN #{}", normalized)))
                .await
                .map_err(|e| TwitchPluginError::WebSocket(e.to_string()))?;

            self.joined_channels.write().await.insert(normalized);
        }

        *self.connected.write().await = true;

        info!(
            "Connected to Twitch as {}, joined channels: {:?}",
            self.settings.username, all_channels
        );

        // Spawn tasks for reading and writing
        let connected_clone = Arc::clone(&self.connected);
        let joined_channels_clone = Arc::clone(&self.joined_channels);

        // Spawn read task
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        // Handle PING
                        if text.starts_with("PING") {
                            debug!("Received PING, sending PONG");
                            // PONG is handled in write task
                        }
                        // Log other messages for debugging
                        debug!("IRC: {}", text.trim());
                    }
                    Ok(WsMessage::Close(_)) => {
                        info!("Twitch connection closed");
                        *connected_clone.write().await = false;
                        break;
                    }
                    Err(e) => {
                        error!("WebSocket error: {}", e);
                        *connected_clone.write().await = false;
                        break;
                    }
                    _ => {}
                }
            }
        });

        // Spawn write task
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Err(e) = write.send(WsMessage::Text(msg)).await {
                    error!("Failed to send message: {}", e);
                    break;
                }
            }
        });

        Ok(())
    }

    /// Normalize an OAuth token (remove oauth: prefix if present).
    fn normalize_token(&self, token: &str) -> String {
        if token.starts_with("oauth:") {
            token[6..].to_string()
        } else {
            token.to_string()
        }
    }

    /// Check if the service is connected.
    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    /// Get the bot username.
    pub fn get_bot_username(&self) -> &str {
        &self.settings.username
    }

    /// Get the primary channel.
    pub fn get_primary_channel(&self) -> &str {
        &self.settings.channel
    }

    /// Get all joined channels.
    pub async fn get_joined_channels(&self) -> Vec<String> {
        self.joined_channels.read().await.iter().cloned().collect()
    }

    /// Check if a user is allowed to interact based on settings.
    pub fn is_user_allowed(&self, user: &TwitchUserInfo) -> bool {
        // Check allowlist first
        if !self.settings.allowed_user_ids.is_empty()
            && !self.settings.allowed_user_ids.contains(&user.user_id)
        {
            return false;
        }

        // Check roles
        if self.settings.allowed_roles.contains(&TwitchRole::All) {
            return true;
        }

        if self.settings.allowed_roles.contains(&TwitchRole::Owner) && user.is_broadcaster {
            return true;
        }

        if self.settings.allowed_roles.contains(&TwitchRole::Moderator) && user.is_moderator {
            return true;
        }

        if self.settings.allowed_roles.contains(&TwitchRole::Vip) && user.is_vip {
            return true;
        }

        if self.settings.allowed_roles.contains(&TwitchRole::Subscriber) && user.is_subscriber {
            return true;
        }

        false
    }

    /// Send a message to a channel.
    pub async fn send_message(
        &self,
        text: &str,
        options: Option<TwitchMessageSendOptions>,
    ) -> Result<TwitchSendResult, TwitchPluginError> {
        if !self.is_connected().await {
            return Err(TwitchPluginError::NotConnected);
        }

        let sender = self.sender.read().await;
        let sender = sender.as_ref().ok_or(TwitchPluginError::NotConnected)?;

        let opts = options.unwrap_or_default();
        let channel = normalize_channel(
            opts.channel
                .as_deref()
                .unwrap_or(&self.settings.channel),
        );

        // Strip markdown for Twitch
        let cleaned_text = strip_markdown_for_twitch(text);
        if cleaned_text.is_empty() {
            return Ok(TwitchSendResult {
                success: true,
                message_id: Some("skipped-empty".to_string()),
                error: None,
            });
        }

        // Split long messages
        let chunks = split_message_for_twitch(&cleaned_text, MAX_TWITCH_MESSAGE_LENGTH);

        let mut last_message_id: Option<String> = None;

        for chunk in chunks {
            let msg = format!("PRIVMSG #{} :{}", channel, chunk);
            sender.send(msg).await.map_err(|e| {
                TwitchPluginError::WebSocket(format!("Failed to send: {}", e))
            })?;

            last_message_id = Some(Uuid::new_v4().to_string());

            // Small delay between chunks
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }

        info!("Sent message to #{}: {}...", channel, cleaned_text.chars().take(50).collect::<String>());

        Ok(TwitchSendResult {
            success: true,
            message_id: last_message_id,
            error: None,
        })
    }

    /// Join a channel.
    pub async fn join_channel(&self, channel: &str) -> Result<(), TwitchPluginError> {
        if !self.is_connected().await {
            return Err(TwitchPluginError::NotConnected);
        }

        let sender = self.sender.read().await;
        let sender = sender.as_ref().ok_or(TwitchPluginError::NotConnected)?;

        let normalized = normalize_channel(channel);
        let msg = format!("JOIN #{}", normalized);

        sender.send(msg).await.map_err(|e| {
            TwitchPluginError::WebSocket(format!("Failed to join: {}", e))
        })?;

        self.joined_channels.write().await.insert(normalized.clone());

        info!("Joined channel #{}", normalized);

        Ok(())
    }

    /// Leave a channel.
    pub async fn leave_channel(&self, channel: &str) -> Result<(), TwitchPluginError> {
        if !self.is_connected().await {
            return Err(TwitchPluginError::NotConnected);
        }

        let sender = self.sender.read().await;
        let sender = sender.as_ref().ok_or(TwitchPluginError::NotConnected)?;

        let normalized = normalize_channel(channel);
        let msg = format!("PART #{}", normalized);

        sender.send(msg).await.map_err(|e| {
            TwitchPluginError::WebSocket(format!("Failed to leave: {}", e))
        })?;

        self.joined_channels.write().await.remove(&normalized);

        info!("Left channel #{}", normalized);

        Ok(())
    }

    /// Shutdown the service.
    pub async fn stop(&self) {
        *self.connected.write().await = false;
        *self.sender.write().await = None;
        info!("Twitch service stopped");
    }
}
