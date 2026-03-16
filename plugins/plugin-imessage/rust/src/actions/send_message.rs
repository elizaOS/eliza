//! Send message action for iMessage

use crate::service::IMessageService;
use crate::types::{format_phone_number, is_email, is_phone_number};
use crate::IMESSAGE_SERVICE_NAME;
use async_trait::async_trait;
use elizaos::{Action, ActionExample, Content, IAgentRuntime, Memory, State};
use regex::Regex;
use tracing::{debug, error, info, warn};

/// Action to send a message via iMessage
pub struct SendMessageAction;

impl SendMessageAction {
    /// Creates a new send message action
    pub fn new() -> Self {
        Self
    }
}

impl Default for SendMessageAction {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract a phone number or email address from message text.
///
/// Scans the text for patterns that look like phone numbers or email addresses
/// and returns the first valid match, formatted appropriately.
pub fn extract_target_from_text(text: &str) -> Option<String> {
    // Try to find phone numbers (patterns like +1234567890, (123) 456-7890, etc.)
    let phone_re = Regex::new(r"[+]?\d[\d\s\-().]{8,14}\d").unwrap();
    for m in phone_re.find_iter(text) {
        let candidate = m.as_str();
        if is_phone_number(candidate) {
            return Some(format_phone_number(candidate));
        }
    }

    // Try to find email addresses
    let email_re = Regex::new(r"[^\s@]+@[^\s@]+\.[^\s@]+").unwrap();
    for m in email_re.find_iter(text) {
        let candidate = m.as_str();
        if is_email(candidate) {
            return Some(candidate.to_string());
        }
    }

    None
}

#[async_trait]
impl Action for SendMessageAction {
    fn name(&self) -> &str {
        "SEND_IMESSAGE"
    }

    fn description(&self) -> &str {
        "Send a message via iMessage (macOS only)"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "TEXT_MESSAGE",
            "IMESSAGE_SEND",
            "APPLE_MESSAGE",
            "MESSAGE_CONTACT",
        ]
    }

    fn examples(&self) -> Vec<Vec<ActionExample>> {
        vec![
            vec![
                ActionExample {
                    name: "{{user1}}".to_string(),
                    content: Content {
                        text: Some(
                            "Can you send a message to John saying I'll be late?".to_string(),
                        ),
                        ..Default::default()
                    },
                },
                ActionExample {
                    name: "{{agentName}}".to_string(),
                    content: Content {
                        text: Some("I'll send that message to John for you.".to_string()),
                        action: Some("SEND_IMESSAGE".to_string()),
                        ..Default::default()
                    },
                },
            ],
            vec![
                ActionExample {
                    name: "{{user1}}".to_string(),
                    content: Content {
                        text: Some("Text mom that I'm on my way home".to_string()),
                        ..Default::default()
                    },
                },
                ActionExample {
                    name: "{{agentName}}".to_string(),
                    content: Content {
                        text: Some("I'll send that text to mom now.".to_string()),
                        action: Some("SEND_IMESSAGE".to_string()),
                        ..Default::default()
                    },
                },
            ],
        ]
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        runtime
            .get_service::<IMessageService>(IMESSAGE_SERVICE_NAME)
            .is_some()
    }

    async fn handler(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&serde_json::Value>,
    ) -> elizaos::Result<Option<Content>> {
        let service = runtime
            .get_service::<IMessageService>(IMESSAGE_SERVICE_NAME)
            .ok_or_else(|| {
                elizaos::Error::ServiceError("iMessage service not available".to_string())
            })?;

        let text = message
            .content
            .text
            .as_deref()
            .ok_or_else(|| elizaos::Error::ValidationError("No message text".to_string()))?;

        if text.trim().is_empty() {
            warn!("Empty message text, skipping send");
            return Ok(None);
        }

        // Try to extract target (phone number or email) from message content,
        // matching the approach used in TypeScript/Python implementations.
        let extracted_target = extract_target_from_text(text);

        let target = if let Some(ref t) = extracted_target {
            debug!("Extracted iMessage target from text: {}", t);
            t.clone()
        } else {
            // Fall back to room channel_id for reply-in-current-chat
            debug!("No target in text, falling back to room channel_id");
            let room = runtime
                .get_room(&message.room_id)
                .await?
                .ok_or_else(|| elizaos::Error::NotFound("Room not found".to_string()))?;

            room.channel_id.ok_or_else(|| {
                elizaos::Error::ValidationError(
                    "No target found in message and no channel ID for room".to_string(),
                )
            })?
        };

        match service.send_message(&target, text, None).await {
            Ok(result) => {
                if result.success {
                    info!("Sent iMessage to {}: {:?}", target, result.message_id);

                    Ok(Some(Content {
                        text: Some(text.to_string()),
                        source: Some("imessage".to_string()),
                        metadata: Some(serde_json::json!({
                            "messageId": result.message_id,
                            "chatId": result.chat_id,
                            "target": target,
                        })),
                        ..Default::default()
                    }))
                } else {
                    error!("Failed to send iMessage: {:?}", result.error);
                    Err(elizaos::Error::ServiceError(
                        result.error.unwrap_or_else(|| "Unknown error".to_string()),
                    ))
                }
            }
            Err(e) => {
                error!("Failed to send iMessage: {}", e);
                Err(elizaos::Error::ServiceError(e.to_string()))
            }
        }
    }
}
