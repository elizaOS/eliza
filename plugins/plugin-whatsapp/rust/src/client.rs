//! WhatsApp Cloud API client

use crate::config::WhatsAppConfig;
use crate::error::{Result, WhatsAppError};
use crate::types::{MessageContent, MessageType, WhatsAppMessage, WhatsAppMessageResponse};
use reqwest::Client;
use serde_json::json;
use tracing::{debug, info};

/// WhatsApp Cloud API client
pub struct WhatsAppClient {
    client: Client,
    config: WhatsAppConfig,
}

impl WhatsAppClient {
    /// Creates a new client
    pub fn new(config: WhatsAppConfig) -> Self {
        let client = Client::new();
        Self { client, config }
    }

    /// Sends a message
    pub async fn send_message(&self, message: &WhatsAppMessage) -> Result<WhatsAppMessageResponse> {
        let url = format!(
            "{}/{}/messages",
            self.config.api_base_url(),
            self.config.phone_number_id
        );

        let payload = self.build_message_payload(message);

        debug!("Sending WhatsApp message to {}", message.to);

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.config.access_token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(WhatsAppError::api(status as i32, body));
        }

        let result: WhatsAppMessageResponse = response.json().await?;
        info!("Message sent successfully: {:?}", result.messages.first().map(|m| &m.id));

        Ok(result)
    }

    /// Sends a text message
    pub async fn send_text(&self, to: &str, text: &str) -> Result<WhatsAppMessageResponse> {
        let message = WhatsAppMessage {
            to: to.to_string(),
            message_type: MessageType::Text,
            content: MessageContent::Text {
                body: text.to_string(),
            },
        };
        self.send_message(&message).await
    }

    /// Sends an image message
    pub async fn send_image(
        &self,
        to: &str,
        media_id: Option<&str>,
        link: Option<&str>,
        caption: Option<&str>,
    ) -> Result<WhatsAppMessageResponse> {
        let message = WhatsAppMessage {
            to: to.to_string(),
            message_type: MessageType::Image,
            content: MessageContent::Media {
                id: media_id.map(String::from),
                link: link.map(String::from),
                caption: caption.map(String::from),
            },
        };
        self.send_message(&message).await
    }

    /// Sends a reaction
    pub async fn send_reaction(
        &self,
        to: &str,
        message_id: &str,
        emoji: &str,
    ) -> Result<WhatsAppMessageResponse> {
        let message = WhatsAppMessage {
            to: to.to_string(),
            message_type: MessageType::Reaction,
            content: MessageContent::Reaction {
                message_id: message_id.to_string(),
                emoji: emoji.to_string(),
            },
        };
        self.send_message(&message).await
    }

    /// Verifies a webhook token
    pub fn verify_webhook(&self, token: &str) -> bool {
        self.config
            .webhook_verify_token
            .as_ref()
            .map(|t| t == token)
            .unwrap_or(false)
    }

    fn build_message_payload(&self, message: &WhatsAppMessage) -> serde_json::Value {
        let mut payload = json!({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": message.to,
            "type": message.message_type,
        });

        match &message.content {
            MessageContent::Text { body } => {
                payload["text"] = json!({ "body": body });
            }
            MessageContent::Media { id, link, caption } => {
                let media_type = match message.message_type {
                    MessageType::Image => "image",
                    MessageType::Audio => "audio",
                    MessageType::Video => "video",
                    MessageType::Document => "document",
                    MessageType::Sticker => "sticker",
                    _ => "image",
                };
                let mut media = serde_json::Map::new();
                if let Some(id) = id {
                    media.insert("id".to_string(), json!(id));
                }
                if let Some(link) = link {
                    media.insert("link".to_string(), json!(link));
                }
                if let Some(caption) = caption {
                    media.insert("caption".to_string(), json!(caption));
                }
                payload[media_type] = serde_json::Value::Object(media);
            }
            MessageContent::Template {
                name,
                language,
                components,
            } => {
                payload["template"] = json!({
                    "name": name,
                    "language": { "code": language.code },
                    "components": components,
                });
            }
            MessageContent::Location {
                latitude,
                longitude,
                name,
                address,
            } => {
                let mut loc = json!({
                    "latitude": latitude,
                    "longitude": longitude,
                });
                if let Some(name) = name {
                    loc["name"] = json!(name);
                }
                if let Some(address) = address {
                    loc["address"] = json!(address);
                }
                payload["location"] = loc;
            }
            MessageContent::Reaction { message_id, emoji } => {
                payload["reaction"] = json!({
                    "message_id": message_id,
                    "emoji": emoji,
                });
            }
        }

        payload
    }
}
