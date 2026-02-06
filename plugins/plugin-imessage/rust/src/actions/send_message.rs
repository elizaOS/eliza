//! Send message action for iMessage

use crate::service::IMessageService;
use crate::IMESSAGE_SERVICE_NAME;
use async_trait::async_trait;
use elizaos::{Action, ActionExample, Content, IAgentRuntime, Memory, State};
use tracing::{error, info, warn};

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
                        text: Some("Can you send a message to John saying I'll be late?".to_string()),
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
        if let Some(service) = runtime.get_service::<IMessageService>(IMESSAGE_SERVICE_NAME) {
            // Check if connected asynchronously would require blocking here
            // For validation, we just check if the service exists
            true
        } else {
            false
        }
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

        // Get the room to find the target
        let room = runtime
            .get_room(&message.room_id)
            .await?
            .ok_or_else(|| elizaos::Error::NotFound("Room not found".to_string()))?;

        let channel_id = room.channel_id.ok_or_else(|| {
            elizaos::Error::ValidationError("No channel ID found for room".to_string())
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

        match service.send_message(&channel_id, text, None).await {
            Ok(result) => {
                if result.success {
                    info!("Sent iMessage: {:?}", result.message_id);

                    Ok(Some(Content {
                        text: Some(text.to_string()),
                        source: Some("imessage".to_string()),
                        metadata: Some(serde_json::json!({
                            "messageId": result.message_id,
                            "chatId": result.chat_id,
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
