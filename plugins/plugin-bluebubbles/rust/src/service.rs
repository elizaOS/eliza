//! BlueBubbles service implementation

use crate::client::BlueBubblesClient;
use crate::config::{is_group_handle_allowed, is_handle_allowed, BlueBubblesConfig};
use crate::error::{BlueBubblesError, Result};
use crate::types::{
    BlueBubblesChat, BlueBubblesChatState, BlueBubblesEventType, BlueBubblesMessage,
    BlueBubblesWebhookPayload,
};
use crate::BLUEBUBBLES_SERVICE_NAME;
use async_trait::async_trait;
use elizaos::{IAgentRuntime, Service};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// BlueBubbles service for elizaOS
pub struct BlueBubblesService {
    client: Option<BlueBubblesClient>,
    config: Option<BlueBubblesConfig>,
    known_chats: Arc<RwLock<HashMap<String, BlueBubblesChat>>>,
    is_running: Arc<RwLock<bool>>,
}

impl BlueBubblesService {
    /// Creates a new service instance
    pub fn new() -> Self {
        Self {
            client: None,
            config: None,
            known_chats: Arc::new(RwLock::new(HashMap::new())),
            is_running: Arc::new(RwLock::new(false)),
        }
    }

    /// Creates a service with the given configuration
    pub fn with_config(config: BlueBubblesConfig) -> Result<Self> {
        config.validate()?;

        let client = BlueBubblesClient::new(&config);

        Ok(Self {
            client: Some(client),
            config: Some(config),
            known_chats: Arc::new(RwLock::new(HashMap::new())),
            is_running: Arc::new(RwLock::new(false)),
        })
    }

    /// Gets the client reference
    pub fn client(&self) -> Option<&BlueBubblesClient> {
        self.client.as_ref()
    }

    /// Gets the configuration
    pub fn config(&self) -> Option<&BlueBubblesConfig> {
        self.config.as_ref()
    }

    /// Checks if the service is running
    pub async fn is_running(&self) -> bool {
        *self.is_running.read().await
    }

    /// Gets the webhook path
    pub fn webhook_path(&self) -> &str {
        self.config
            .as_ref()
            .map(|c| c.webhook_path.as_str())
            .unwrap_or("/webhooks/bluebubbles")
    }

    /// Initializes the service
    pub async fn initialize(&mut self) -> Result<()> {
        let config = match BlueBubblesConfig::from_env() {
            Ok(c) => c,
            Err(e) => {
                warn!("BlueBubbles configuration not available: {}", e);
                return Ok(());
            }
        };

        if !config.enabled {
            info!("BlueBubbles plugin is disabled via configuration");
            return Ok(());
        }

        config.validate()?;

        let client = BlueBubblesClient::new(&config);

        // Probe the server
        let probe_result = client.probe(5000).await;
        if !probe_result.ok {
            error!(
                "Failed to connect to BlueBubbles server: {}",
                probe_result.error.unwrap_or_default()
            );
            return Err(BlueBubblesError::connection(
                probe_result.error.unwrap_or_else(|| "Unknown error".to_string()),
            ));
        }

        info!(
            "Connected to BlueBubbles server v{} on macOS {}",
            probe_result.server_version.unwrap_or_default(),
            probe_result.os_version.unwrap_or_default()
        );

        if probe_result.private_api_enabled.unwrap_or(false) {
            info!("BlueBubbles Private API is enabled - edit and unsend features available");
        }

        // Load initial chats
        match client.list_chats(100, 0).await {
            Ok(chats) => {
                let mut known = self.known_chats.write().await;
                for chat in chats {
                    known.insert(chat.guid.clone(), chat);
                }
                info!("Loaded {} BlueBubbles chats", known.len());
            }
            Err(e) => {
                warn!("Failed to load initial chats: {}", e);
            }
        }

        self.client = Some(client);
        self.config = Some(config);
        *self.is_running.write().await = true;

        info!("BlueBubbles service started");
        Ok(())
    }

    /// Stops the service
    pub async fn stop(&self) {
        *self.is_running.write().await = false;
        info!("BlueBubbles service stopped");
    }

    /// Handles an incoming webhook payload
    pub async fn handle_webhook(&self, payload: BlueBubblesWebhookPayload) -> Result<()> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| BlueBubblesError::config("Service not configured"))?;

        let event_type = BlueBubblesEventType::from_str(&payload.event_type);

        match event_type {
            Some(BlueBubblesEventType::NewMessage) => {
                let message: BlueBubblesMessage = serde_json::from_value(payload.data)?;
                self.handle_incoming_message(&message, config).await?;
            }
            Some(BlueBubblesEventType::UpdatedMessage) => {
                let message: BlueBubblesMessage = serde_json::from_value(payload.data)?;
                self.handle_message_update(&message).await?;
            }
            Some(BlueBubblesEventType::ChatUpdated) => {
                let chat: BlueBubblesChat = serde_json::from_value(payload.data)?;
                self.handle_chat_update(chat).await?;
            }
            Some(BlueBubblesEventType::TypingIndicator)
            | Some(BlueBubblesEventType::ReadReceipt) => {
                debug!("BlueBubbles {}: {:?}", payload.event_type, payload.data);
            }
            _ => {
                debug!("Unhandled BlueBubbles event: {}", payload.event_type);
            }
        }

        Ok(())
    }

    /// Handles an incoming message
    async fn handle_incoming_message(
        &self,
        message: &BlueBubblesMessage,
        config: &BlueBubblesConfig,
    ) -> Result<()> {
        // Skip outgoing messages
        if message.is_from_me {
            return Ok(());
        }

        // Skip system messages
        if message.is_system_message {
            return Ok(());
        }

        let chat = message
            .chats
            .first()
            .ok_or_else(|| BlueBubblesError::internal("Message without chat info"))?;

        let is_group = chat.participants.len() > 1;
        let sender_handle = message
            .handle
            .as_ref()
            .map(|h| h.address.as_str())
            .unwrap_or("");

        // Check access policies
        if is_group {
            if !is_group_handle_allowed(sender_handle, &config.group_allow_from, config.group_policy)
            {
                debug!("Ignoring message from {} - not in group allowlist", sender_handle);
                return Ok(());
            }
        } else if !is_handle_allowed(sender_handle, &config.allow_from, config.dm_policy) {
            debug!("Ignoring message from {} - not in DM allowlist", sender_handle);
            return Ok(());
        }

        // Mark as read if configured
        if config.send_read_receipts {
            if let Some(client) = &self.client {
                if let Err(e) = client.mark_chat_read(&chat.guid).await {
                    debug!("Failed to mark chat as read: {}", e);
                }
            }
        }

        info!(
            "Received message from {} in chat {}: {}",
            sender_handle,
            chat.guid,
            message.text.as_deref().unwrap_or("[no text]")
        );

        // TODO: Emit message event to runtime
        Ok(())
    }

    /// Handles a message update
    async fn handle_message_update(&self, message: &BlueBubblesMessage) -> Result<()> {
        if message.date_edited.is_some() {
            debug!("Message {} was edited", message.guid);
        }
        Ok(())
    }

    /// Handles a chat update
    async fn handle_chat_update(&self, chat: BlueBubblesChat) -> Result<()> {
        let mut known = self.known_chats.write().await;
        debug!(
            "Chat {} updated: {}",
            chat.guid,
            chat.display_name.as_deref().unwrap_or(&chat.chat_identifier)
        );
        known.insert(chat.guid.clone(), chat);
        Ok(())
    }

    /// Sends a message to a target
    pub async fn send_message(
        &self,
        target: &str,
        text: &str,
        _reply_to_id: Option<&str>,
    ) -> Result<String> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| BlueBubblesError::config("Client not initialized"))?;

        let chat_guid = client.resolve_target(target).await?;
        let result = client.send_message(&chat_guid, text, None).await?;

        Ok(result.guid)
    }

    /// Gets the state for a chat
    pub async fn get_chat_state(&self, chat_guid: &str) -> Result<Option<BlueBubblesChatState>> {
        let known = self.known_chats.read().await;

        if let Some(chat) = known.get(chat_guid) {
            return Ok(Some(Self::chat_to_state(chat)));
        }

        // Try to fetch from server
        if let Some(client) = &self.client {
            match client.get_chat(chat_guid).await {
                Ok(chat) => {
                    let state = Self::chat_to_state(&chat);
                    drop(known);
                    let mut known = self.known_chats.write().await;
                    known.insert(chat.guid.clone(), chat);
                    return Ok(Some(state));
                }
                Err(_) => return Ok(None),
            }
        }

        Ok(None)
    }

    fn chat_to_state(chat: &BlueBubblesChat) -> BlueBubblesChatState {
        BlueBubblesChatState {
            chat_guid: chat.guid.clone(),
            chat_identifier: chat.chat_identifier.clone(),
            is_group: chat.participants.len() > 1,
            participants: chat.participants.iter().map(|p| p.address.clone()).collect(),
            display_name: chat.display_name.clone(),
            last_message_at: chat.last_message.as_ref().map(|m| m.date_created),
            has_unread: chat.has_unread_messages,
        }
    }
}

impl Default for BlueBubblesService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for BlueBubblesService {
    fn name(&self) -> &str {
        BLUEBUBBLES_SERVICE_NAME
    }

    fn description(&self) -> &str {
        "BlueBubbles iMessage bridge service"
    }

    async fn start(&mut self, _runtime: &dyn IAgentRuntime) -> elizaos::Result<()> {
        self.initialize()
            .await
            .map_err(|e| elizaos::Error::ServiceError(e.to_string()))
    }

    async fn stop(&mut self, _runtime: &dyn IAgentRuntime) -> elizaos::Result<()> {
        self.stop().await;
        Ok(())
    }
}
