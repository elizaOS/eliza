//! Send message action for WhatsApp

use crate::error::{Result, WhatsAppError};
use crate::service::WhatsAppService;
use std::sync::Arc;
use tracing::{error, info, warn};

/// Action to send a message via WhatsApp
pub struct SendMessageAction {
    service: Option<Arc<WhatsAppService>>,
}

impl SendMessageAction {
    pub fn new() -> Self {
        Self { service: None }
    }

    /// Create with a service reference
    pub fn with_service(service: Arc<WhatsAppService>) -> Self {
        Self {
            service: Some(service),
        }
    }

    /// Get the action name
    pub fn name(&self) -> &str {
        "SEND_WHATSAPP_MESSAGE"
    }

    /// Get the action description
    pub fn description(&self) -> &str {
        "Send a message via WhatsApp Cloud API"
    }

    /// Get action similes
    pub fn similes(&self) -> Vec<&str> {
        vec!["WHATSAPP_SEND", "TEXT_WHATSAPP", "MESSAGE_WHATSAPP"]
    }

    /// Validate if the action can be executed
    pub fn validate(&self) -> bool {
        self.service.is_some()
    }

    /// Execute the action to send a message
    pub async fn send(&self, channel_id: &str, text: &str) -> Result<Option<serde_json::Value>> {
        let service = self
            .service
            .as_ref()
            .ok_or_else(|| WhatsAppError::config("WhatsApp service not available"))?;

        if text.trim().is_empty() {
            warn!("Empty message text, skipping send");
            return Ok(None);
        }

        match service.send_message(channel_id, text).await {
            Ok(result) => {
                let message_id = result.messages.first().map(|m| m.id.clone());
                info!("Sent WhatsApp message: {:?}", message_id);

                Ok(Some(serde_json::json!({
                    "text": text,
                    "source": "whatsapp",
                    "messageId": message_id,
                    "to": channel_id,
                })))
            }
            Err(e) => {
                error!("Failed to send WhatsApp message: {}", e);
                Err(e)
            }
        }
    }
}

impl Default for SendMessageAction {
    fn default() -> Self {
        Self::new()
    }
}
