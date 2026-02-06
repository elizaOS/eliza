//! Chat state provider for WhatsApp

use crate::service::WhatsAppService;
use crate::types::WhatsAppChatState;
use std::sync::Arc;

/// Provider that supplies WhatsApp chat context
pub struct ChatStateProvider {
    service: Option<Arc<WhatsAppService>>,
}

impl ChatStateProvider {
    pub fn new() -> Self {
        Self { service: None }
    }

    /// Create with a service reference
    pub fn with_service(service: Arc<WhatsAppService>) -> Self {
        Self {
            service: Some(service),
        }
    }

    /// Get the provider name
    pub fn name(&self) -> &str {
        "WHATSAPP_CHAT_STATE"
    }

    /// Get the provider description
    pub fn description(&self) -> &str {
        "Provides information about the current WhatsApp chat context"
    }

    /// Get chat state for a given contact
    pub async fn get_chat_state(&self, contact_id: &str) -> Option<String> {
        let service = self.service.as_ref()?;
        let chat_state = service.get_chat_state(contact_id).await?;
        Some(format_chat_state(&chat_state))
    }
}

impl Default for ChatStateProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn format_chat_state(state: &WhatsAppChatState) -> String {
    let mut lines = vec![
        "# WhatsApp Chat Context".to_string(),
        String::new(),
        format!("- Contact: {}", state.contact_wa_id),
    ];

    if let Some(ref name) = state.contact_name {
        lines.push(format!("- Name: {}", name));
    }

    if let Some(timestamp) = state.last_message_at {
        lines.push(format!("- Last Message: {} (timestamp)", timestamp));
    }

    lines.push(String::new());
    lines.push("Note: This conversation is on WhatsApp. Be helpful and concise.".to_string());

    lines.join("\n")
}
