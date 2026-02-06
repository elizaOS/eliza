//! WhatsApp service implementation

use crate::client::WhatsAppClient;
use crate::config::WhatsAppConfig;
use crate::error::{Result, WhatsAppError};
use crate::types::{IncomingMessage, WhatsAppChatState, WhatsAppMessageResponse, WhatsAppWebhookEvent};
use crate::WHATSAPP_SERVICE_NAME;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/// WhatsApp service for ElizaOS
pub struct WhatsAppService {
    client: Arc<RwLock<Option<WhatsAppClient>>>,
    config: Arc<RwLock<Option<WhatsAppConfig>>>,
    chat_states: Arc<RwLock<HashMap<String, WhatsAppChatState>>>,
    is_running: Arc<RwLock<bool>>,
}

impl WhatsAppService {
    /// Creates a new service instance
    pub fn new() -> Self {
        Self {
            client: Arc::new(RwLock::new(None)),
            config: Arc::new(RwLock::new(None)),
            chat_states: Arc::new(RwLock::new(HashMap::new())),
            is_running: Arc::new(RwLock::new(false)),
        }
    }

    /// Creates a service with the given configuration
    pub fn with_config(config: WhatsAppConfig) -> Result<Self> {
        config.validate()?;
        let client = WhatsAppClient::new(config.clone());
        
        Ok(Self {
            client: Arc::new(RwLock::new(Some(client))),
            config: Arc::new(RwLock::new(Some(config))),
            chat_states: Arc::new(RwLock::new(HashMap::new())),
            is_running: Arc::new(RwLock::new(false)),
        })
    }

    /// Gets the client reference
    pub async fn client(&self) -> Option<WhatsAppClient> {
        let config = self.config.read().await;
        config.as_ref().map(|c| WhatsAppClient::new(c.clone()))
    }

    /// Checks if the service is running
    pub async fn is_running(&self) -> bool {
        *self.is_running.read().await
    }

    /// Initializes the service
    pub async fn initialize(&self) -> Result<()> {
        let config = match WhatsAppConfig::from_env() {
            Ok(c) => c,
            Err(e) => {
                warn!("WhatsApp configuration not available: {}", e);
                return Err(e);
            }
        };

        if !config.enabled {
            info!("WhatsApp plugin is disabled via configuration");
            return Ok(());
        }

        let client = WhatsAppClient::new(config.clone());

        *self.config.write().await = Some(config);
        *self.client.write().await = Some(client);
        *self.is_running.write().await = true;

        info!("WhatsApp service started");
        Ok(())
    }

    /// Stops the service
    pub async fn stop(&self) {
        *self.is_running.write().await = false;
        *self.client.write().await = None;
        info!("WhatsApp service stopped");
    }

    /// Sends a text message
    pub async fn send_message(&self, to: &str, text: &str) -> Result<WhatsAppMessageResponse> {
        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| WhatsAppError::config("Client not initialized"))?;

        client.send_text(to, text).await
    }

    /// Handles a webhook event
    pub async fn handle_webhook(&self, event: WhatsAppWebhookEvent) -> Result<()> {
        for entry in event.entry {
            for change in entry.changes {
                if change.field == "messages" {
                    if let Some(messages) = change.value.messages {
                        for message in messages {
                            self.handle_incoming_message(&message, &change.value.metadata.phone_number_id)
                                .await?;
                        }
                    }
                    
                    // Update contact info
                    if let Some(contacts) = change.value.contacts {
                        for contact in contacts {
                            let state = WhatsAppChatState {
                                phone_number_id: change.value.metadata.phone_number_id.clone(),
                                contact_wa_id: contact.wa_id.clone(),
                                contact_name: Some(contact.profile.name),
                                last_message_at: Some(chrono::Utc::now().timestamp()),
                            };
                            self.chat_states.write().await.insert(contact.wa_id, state);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn handle_incoming_message(&self, message: &IncomingMessage, phone_number_id: &str) -> Result<()> {
        info!(
            "Received message from {} (type: {})",
            message.from, message.message_type
        );

        // Extract text content
        let text = message.text.as_ref().map(|t| t.body.as_str());

        if let Some(text) = text {
            debug!("Message text: {}", text);
        }

        // Update chat state
        let state = WhatsAppChatState {
            phone_number_id: phone_number_id.to_string(),
            contact_wa_id: message.from.clone(),
            contact_name: None,
            last_message_at: Some(
                message
                    .timestamp
                    .parse::<i64>()
                    .unwrap_or_else(|_| chrono::Utc::now().timestamp()),
            ),
        };
        self.chat_states.write().await.insert(message.from.clone(), state);

        Ok(())
    }

    /// Verifies a webhook token
    pub async fn verify_webhook(&self, token: &str) -> bool {
        let client_guard = self.client.read().await;
        client_guard
            .as_ref()
            .map(|c| c.verify_webhook(token))
            .unwrap_or(false)
    }

    /// Gets chat state for a contact
    pub async fn get_chat_state(&self, wa_id: &str) -> Option<WhatsAppChatState> {
        self.chat_states.read().await.get(wa_id).cloned()
    }
}

impl Default for WhatsAppService {
    fn default() -> Self {
        Self::new()
    }
}

impl WhatsAppService {
    /// Get the service name
    pub fn name(&self) -> &str {
        WHATSAPP_SERVICE_NAME
    }

    /// Get the service description
    pub fn description(&self) -> &str {
        "WhatsApp Cloud API service"
    }
}
