use std::collections::HashMap;

use reqwest::Client;
use tracing::{info, warn};

use crate::constants::{error_messages, MAX_CONVERSATION_HISTORY};
use crate::types::{BlooioConfig, BlooioError, BlooioResponse, ConversationEntry, MessageTarget};
use crate::utils;

/// Percent-encode a string for use in a URL path component (matches
/// JavaScript's `encodeURIComponent` for ASCII inputs).
fn encode_uri_component(s: &str) -> String {
    let mut encoded = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'!'
            | b'*'
            | b'\''
            | b'('
            | b')' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// Blooio messaging service — HTTP client wrapper with conversation history.
pub struct BlooioService {
    config: BlooioConfig,
    client: Client,
    conversation_history: HashMap<String, Vec<ConversationEntry>>,
    max_history: usize,
}

impl BlooioService {
    /// Create a new `BlooioService` from the given configuration.
    pub fn new(config: BlooioConfig) -> Self {
        info!("BlooioService initialized");
        Self {
            config,
            client: Client::new(),
            conversation_history: HashMap::new(),
            max_history: MAX_CONVERSATION_HISTORY,
        }
    }

    /// Access the service configuration.
    pub fn config(&self) -> &BlooioConfig {
        &self.config
    }

    /// Send a message to the given target via the Blooio API.
    pub async fn send_message(
        &self,
        target: &MessageTarget,
        text: &str,
        attachments: &[String],
    ) -> Result<BlooioResponse, BlooioError> {
        let chat_id = target.as_chat_id();

        if !utils::validate_chat_id(chat_id) {
            return Err(BlooioError::ValidationError(
                error_messages::INVALID_CHAT_ID.to_string(),
            ));
        }

        let encoded_chat_id = encode_uri_component(chat_id);
        let url = format!(
            "{}/chats/{}/messages",
            self.config.api_base_url, encoded_chat_id
        );

        let body = serde_json::json!({
            "text": text,
            "attachments": attachments,
        });

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.config.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| BlooioError::NetworkError(e.to_string()))?;

        let status = response.status().as_u16();
        if !response.status().is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(BlooioError::ApiError {
                status,
                body: body_text,
            });
        }

        let data: BlooioResponse = response
            .json()
            .await
            .map_err(|e| BlooioError::ParseError(e.to_string()))?;

        Ok(data)
    }

    /// Retrieve recent conversation history for a chat, most recent last.
    pub fn get_conversation_history(
        &self,
        chat_id: &str,
        limit: usize,
    ) -> Vec<ConversationEntry> {
        match self.conversation_history.get(chat_id) {
            Some(entries) => {
                if limit == 0 {
                    return vec![];
                }
                if entries.len() <= limit {
                    entries.clone()
                } else {
                    entries[entries.len() - limit..].to_vec()
                }
            }
            None => Vec::new(),
        }
    }

    /// Append a conversation entry for the given chat.
    pub fn add_to_history(&mut self, chat_id: &str, entry: ConversationEntry) {
        let entries = self
            .conversation_history
            .entry(chat_id.to_string())
            .or_default();
        entries.push(entry);
        if entries.len() > self.max_history {
            let start = entries.len() - self.max_history;
            *entries = entries[start..].to_vec();
        }
    }

    /// Verify an incoming webhook payload against the configured secret.
    ///
    /// Returns `true` when no secret is configured (verification is skipped).
    pub fn verify_webhook(&self, payload: &[u8], signature: &str) -> bool {
        match &self.config.webhook_secret {
            Some(secret) => utils::verify_webhook_signature(payload, signature, secret),
            None => {
                warn!("No webhook secret configured, skipping verification");
                true
            }
        }
    }
}
