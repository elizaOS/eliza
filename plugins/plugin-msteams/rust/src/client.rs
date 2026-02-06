//! MS Teams Bot Framework client implementation.

use crate::config::MSTeamsConfig;
use crate::error::{MSTeamsError, Result};
use crate::types::{MSTeamsConversationReference, MSTeamsSendOptions, MSTeamsSendResult};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Maximum message length for MS Teams.
pub const MAX_MESSAGE_LENGTH: usize = 4000;

/// MS Teams media size limit (100MB).
pub const MAX_MEDIA_BYTES: usize = 100 * 1024 * 1024;

/// Bot Framework OAuth token endpoint.
const TOKEN_ENDPOINT: &str =
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

/// Bot Framework token response.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

/// Bot Framework activity for sending messages.
#[derive(Debug, Serialize)]
struct Activity {
    #[serde(rename = "type")]
    activity_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachments: Option<Vec<serde_json::Value>>,
    #[serde(rename = "replyToId", skip_serializing_if = "Option::is_none")]
    reply_to_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entities: Option<Vec<serde_json::Value>>,
}

/// Bot Framework send activity response.
#[derive(Debug, Deserialize)]
struct SendActivityResponse {
    id: Option<String>,
}

/// Token cache entry.
struct CachedToken {
    token: String,
    expires_at: std::time::Instant,
}

/// MS Teams Bot Framework client.
pub struct MSTeamsClient {
    config: MSTeamsConfig,
    http_client: Client,
    conversation_refs: Arc<RwLock<HashMap<String, MSTeamsConversationReference>>>,
    token_cache: Arc<RwLock<Option<CachedToken>>>,
}

impl MSTeamsClient {
    /// Creates a new MS Teams client from configuration.
    pub fn new(config: MSTeamsConfig) -> Self {
        Self {
            config,
            http_client: Client::new(),
            conversation_refs: Arc::new(RwLock::new(HashMap::new())),
            token_cache: Arc::new(RwLock::new(None)),
        }
    }

    /// Returns the configuration.
    pub fn config(&self) -> &MSTeamsConfig {
        &self.config
    }

    /// Store a conversation reference for proactive messaging.
    pub async fn store_conversation_reference(&self, conv_ref: MSTeamsConversationReference) {
        let conv_id = conv_ref.conversation.id.clone();
        let mut refs = self.conversation_refs.write().await;
        refs.insert(conv_id, conv_ref);
    }

    /// Get a stored conversation reference.
    pub async fn get_conversation_reference(
        &self,
        conversation_id: &str,
    ) -> Option<MSTeamsConversationReference> {
        let refs = self.conversation_refs.read().await;
        refs.get(conversation_id).cloned()
    }

    /// Get an access token for the Bot Framework.
    async fn get_access_token(&self) -> Result<String> {
        // Check cache first
        {
            let cache = self.token_cache.read().await;
            if let Some(ref cached) = *cache {
                if cached.expires_at > std::time::Instant::now() {
                    return Ok(cached.token.clone());
                }
            }
        }

        // Fetch new token
        let params = [
            ("grant_type", "client_credentials"),
            ("client_id", &self.config.app_id),
            ("client_secret", &self.config.app_password),
            (
                "scope",
                "https://api.botframework.com/.default",
            ),
        ];

        let response = self
            .http_client
            .post(TOKEN_ENDPOINT)
            .form(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(MSTeamsError::AuthError(format!(
                "Token request failed with status {}: {}",
                status, body
            )));
        }

        let token_response: TokenResponse = response.json().await?;

        // Cache the token (with 5 minute buffer)
        let expires_at =
            std::time::Instant::now() + std::time::Duration::from_secs(token_response.expires_in.saturating_sub(300));

        {
            let mut cache = self.token_cache.write().await;
            *cache = Some(CachedToken {
                token: token_response.access_token.clone(),
                expires_at,
            });
        }

        Ok(token_response.access_token)
    }

    /// Send a proactive message to a conversation.
    pub async fn send_proactive_message(
        &self,
        conversation_id: &str,
        text: &str,
        options: Option<MSTeamsSendOptions>,
    ) -> Result<MSTeamsSendResult> {
        let conv_ref = self
            .get_conversation_reference(conversation_id)
            .await
            .ok_or_else(|| {
                MSTeamsError::ConversationNotFound(conversation_id.to_string())
            })?;

        let service_url = conv_ref
            .service_url
            .as_ref()
            .ok_or_else(|| MSTeamsError::InvalidArgument("Missing service URL".to_string()))?;

        let token = self.get_access_token().await?;

        let url = format!(
            "{}/v3/conversations/{}/activities",
            service_url.trim_end_matches('/'),
            conversation_id
        );

        let mut activity = Activity {
            activity_type: "message".to_string(),
            text: Some(text.to_string()),
            attachments: None,
            reply_to_id: options.as_ref().and_then(|o| o.reply_to_id.clone()),
            entities: None,
        };

        // Add Adaptive Card if provided
        if let Some(ref opts) = options {
            if let Some(ref card) = opts.adaptive_card {
                activity.attachments = Some(vec![serde_json::json!({
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": card
                })]);
            }

            // Add mentions
            if !opts.mentions.is_empty() {
                let entities: Vec<serde_json::Value> = opts
                    .mentions
                    .iter()
                    .map(|m| {
                        serde_json::json!({
                            "type": "mention",
                            "mentioned": {
                                "id": m.mentioned.id,
                                "name": m.mentioned.name
                            },
                            "text": m.text
                        })
                    })
                    .collect();
                activity.entities = Some(entities);
            }
        }

        let response = self
            .http_client
            .post(&url)
            .bearer_auth(&token)
            .json(&activity)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(MSTeamsError::ApiError(format!(
                "Send activity failed with status {}: {}",
                status, body
            )));
        }

        let send_response: SendActivityResponse = response.json().await?;

        Ok(MSTeamsSendResult {
            message_id: send_response.id.clone().unwrap_or_default(),
            conversation_id: conversation_id.to_string(),
            activity_id: send_response.id,
        })
    }

    /// Send an Adaptive Card to a conversation.
    pub async fn send_adaptive_card(
        &self,
        conversation_id: &str,
        card: serde_json::Value,
        fallback_text: Option<&str>,
    ) -> Result<MSTeamsSendResult> {
        let options = MSTeamsSendOptions {
            adaptive_card: Some(card),
            ..Default::default()
        };

        self.send_proactive_message(
            conversation_id,
            fallback_text.unwrap_or(""),
            Some(options),
        )
        .await
    }

    /// Send a poll as an Adaptive Card.
    pub async fn send_poll(
        &self,
        conversation_id: &str,
        question: &str,
        options: &[String],
        max_selections: u32,
    ) -> Result<(MSTeamsSendResult, String)> {
        let poll_id = uuid::Uuid::new_v4().to_string();
        let capped_max = max_selections.min(options.len() as u32).max(1);

        let choices: Vec<serde_json::Value> = options
            .iter()
            .enumerate()
            .map(|(i, opt)| {
                serde_json::json!({
                    "title": opt,
                    "value": i.to_string()
                })
            })
            .collect();

        let hint = if capped_max > 1 {
            format!("Select up to {} options.", capped_max)
        } else {
            "Select one option.".to_string()
        };

        let card = serde_json::json!({
            "type": "AdaptiveCard",
            "version": "1.5",
            "body": [
                {
                    "type": "TextBlock",
                    "text": question,
                    "wrap": true,
                    "weight": "Bolder",
                    "size": "Medium"
                },
                {
                    "type": "Input.ChoiceSet",
                    "id": "choices",
                    "isMultiSelect": capped_max > 1,
                    "style": "expanded",
                    "choices": choices
                },
                {
                    "type": "TextBlock",
                    "text": hint,
                    "wrap": true,
                    "isSubtle": true,
                    "spacing": "Small"
                }
            ],
            "actions": [
                {
                    "type": "Action.Submit",
                    "title": "Vote",
                    "data": {
                        "pollId": poll_id,
                        "action": "vote"
                    }
                }
            ]
        });

        let fallback_lines: Vec<String> = std::iter::once(format!("Poll: {}", question))
            .chain(
                options
                    .iter()
                    .enumerate()
                    .map(|(i, opt)| format!("{}. {}", i + 1, opt)),
            )
            .collect();

        let result = self
            .send_adaptive_card(conversation_id, card, Some(&fallback_lines.join("\n")))
            .await?;

        Ok((result, poll_id))
    }

    /// Reply to a message in a conversation.
    pub async fn reply_to_message(
        &self,
        conversation_id: &str,
        reply_to_id: &str,
        text: &str,
    ) -> Result<MSTeamsSendResult> {
        let options = MSTeamsSendOptions {
            reply_to_id: Some(reply_to_id.to_string()),
            ..Default::default()
        };

        self.send_proactive_message(conversation_id, text, Some(options))
            .await
    }

    /// Split a long message into chunks.
    pub fn split_message(text: &str) -> Vec<String> {
        if text.len() <= MAX_MESSAGE_LENGTH {
            return vec![text.to_string()];
        }

        let mut parts = Vec::new();
        let mut current = String::new();

        for line in text.lines() {
            let line_with_newline = if current.is_empty() {
                line.to_string()
            } else {
                format!("\n{}", line)
            };

            if current.len() + line_with_newline.len() > MAX_MESSAGE_LENGTH {
                if !current.is_empty() {
                    parts.push(current);
                    current = String::new();
                }

                if line.len() > MAX_MESSAGE_LENGTH {
                    // Split by words
                    let words: Vec<&str> = line.split_whitespace().collect();
                    for word in words {
                        let word_with_space = if current.is_empty() {
                            word.to_string()
                        } else {
                            format!(" {}", word)
                        };

                        if current.len() + word_with_space.len() > MAX_MESSAGE_LENGTH {
                            if !current.is_empty() {
                                parts.push(current);
                                current = String::new();
                            }

                            if word.len() > MAX_MESSAGE_LENGTH {
                                // Split by characters
                                for chunk in word.chars().collect::<Vec<_>>().chunks(MAX_MESSAGE_LENGTH) {
                                    parts.push(chunk.iter().collect());
                                }
                            } else {
                                current = word.to_string();
                            }
                        } else {
                            current.push_str(&word_with_space);
                        }
                    }
                } else {
                    current = line.to_string();
                }
            } else {
                current.push_str(&line_with_newline);
            }
        }

        if !current.is_empty() {
            parts.push(current);
        }

        parts
    }

    /// Strip mention tags from message text.
    pub fn strip_mention_tags(text: &str) -> String {
        // Teams wraps mentions in <at>...</at> tags
        let re = regex::Regex::new(r"<at[^>]*>.*?</at>").unwrap();
        re.replace_all(text, "").trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_message_short() {
        let msg = "Hello, world!";
        let parts = MSTeamsClient::split_message(msg);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], msg);
    }

    #[test]
    fn test_split_message_long() {
        let msg = "a".repeat(MAX_MESSAGE_LENGTH + 500);
        let parts = MSTeamsClient::split_message(&msg);
        assert!(parts.len() > 1);
        for part in &parts {
            assert!(part.len() <= MAX_MESSAGE_LENGTH);
        }
    }

    #[test]
    fn test_strip_mention_tags() {
        let text = "Hello <at>@User</at>, how are you?";
        let cleaned = MSTeamsClient::strip_mention_tags(text);
        assert_eq!(cleaned, "Hello , how are you?");
    }
}
