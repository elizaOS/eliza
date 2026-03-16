//! Type definitions for the WhatsApp plugin

use serde::{Deserialize, Serialize};

/// WhatsApp message types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageType {
    Text,
    Image,
    Audio,
    Video,
    Document,
    Sticker,
    Location,
    Contacts,
    Template,
    Interactive,
    Reaction,
}

/// WhatsApp message to send
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppMessage {
    pub to: String,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    pub content: MessageContent,
}

/// Message content variants
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text { body: String },
    Media { id: Option<String>, link: Option<String>, caption: Option<String> },
    Template { name: String, language: TemplateLanguage, components: Vec<TemplateComponent> },
    Location { latitude: f64, longitude: f64, name: Option<String>, address: Option<String> },
    Reaction { message_id: String, emoji: String },
}

/// Template language
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateLanguage {
    pub code: String,
}

/// Template component
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateComponent {
    #[serde(rename = "type")]
    pub component_type: String,
    pub parameters: Vec<serde_json::Value>,
}

/// Message send response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppMessageResponse {
    pub messaging_product: String,
    pub contacts: Vec<WhatsAppContact>,
    pub messages: Vec<WhatsAppMessageId>,
}

/// Contact in response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppContact {
    pub input: String,
    pub wa_id: String,
}

/// Message ID in response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppMessageId {
    pub id: String,
}

/// Webhook event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppWebhookEvent {
    pub object: String,
    pub entry: Vec<WebhookEntry>,
}

/// Webhook entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookEntry {
    pub id: String,
    pub changes: Vec<WebhookChange>,
}

/// Webhook change
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookChange {
    pub value: WebhookValue,
    pub field: String,
}

/// Webhook value
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookValue {
    pub messaging_product: String,
    pub metadata: WebhookMetadata,
    pub contacts: Option<Vec<WebhookContact>>,
    pub messages: Option<Vec<IncomingMessage>>,
    pub statuses: Option<Vec<MessageStatus>>,
}

/// Webhook metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookMetadata {
    pub display_phone_number: String,
    pub phone_number_id: String,
}

/// Webhook contact
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookContact {
    pub profile: ContactProfile,
    pub wa_id: String,
}

/// Contact profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactProfile {
    pub name: String,
}

/// Incoming message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingMessage {
    pub from: String,
    pub id: String,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub text: Option<TextMessage>,
    pub image: Option<MediaMessage>,
    pub audio: Option<MediaMessage>,
    pub video: Option<MediaMessage>,
    pub document: Option<MediaMessage>,
    pub sticker: Option<MediaMessage>,
    pub location: Option<LocationMessage>,
    pub reaction: Option<ReactionMessage>,
}

/// Text message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMessage {
    pub body: String,
}

/// Media message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMessage {
    pub id: String,
    pub mime_type: Option<String>,
    pub sha256: Option<String>,
    pub caption: Option<String>,
}

/// Location message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationMessage {
    pub latitude: f64,
    pub longitude: f64,
    pub name: Option<String>,
    pub address: Option<String>,
}

/// Reaction message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionMessage {
    pub message_id: String,
    pub emoji: String,
}

/// Message status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageStatus {
    pub id: String,
    pub status: String,
    pub timestamp: String,
    pub recipient_id: String,
}

/// Chat state for provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppChatState {
    pub phone_number_id: String,
    pub contact_wa_id: String,
    pub contact_name: Option<String>,
    pub last_message_at: Option<i64>,
}
