//! Send message action for BlueBubbles

use crate::service::BlueBubblesService;
use crate::BLUEBUBBLES_SERVICE_NAME;
use async_trait::async_trait;
use elizaos::{Action, ActionExample, Content, IAgentRuntime, Memory, State};
use tracing::{error, info, warn};

/// Action to send a message via BlueBubbles/iMessage
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
        "SEND_BLUEBUBBLES_MESSAGE"
    }

    fn description(&self) -> &str {
        "Send a message via iMessage through BlueBubbles"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SEND_IMESSAGE",
            "TEXT_MESSAGE",
            "IMESSAGE_REPLY",
            "BLUEBUBBLES_SEND",
            "APPLE_MESSAGE",
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
                        action: Some("SEND_BLUEBUBBLES_MESSAGE".to_string()),
                        ..Default::default()
                    },
                },
            ],
            vec![
                ActionExample {
                    name: "{{user1}}".to_string(),
                    content: Content {
                        text: Some("Reply to this iMessage for me".to_string()),
                        ..Default::default()
                    },
                },
                ActionExample {
                    name: "{{agentName}}".to_string(),
                    content: Content {
                        text: Some("I'll compose and send a reply for you.".to_string()),
                        action: Some("SEND_BLUEBUBBLES_MESSAGE".to_string()),
                        ..Default::default()
                    },
                },
            ],
        ]
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        if let Some(service) = runtime.get_service::<BlueBubblesService>(BLUEBUBBLES_SERVICE_NAME) {
            // Use a blocking read for validation
            // In production, this should be made async-safe
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
            .get_service::<BlueBubblesService>(BLUEBUBBLES_SERVICE_NAME)
            .ok_or_else(|| {
                elizaos::Error::ServiceError("BlueBubbles service not available".to_string())
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

        let reply_to = message.content.in_reply_to.as_deref();

        match service.send_message(&channel_id, text, reply_to).await {
            Ok(guid) => {
                info!("Sent BlueBubbles message: {}", guid);

                Ok(Some(Content {
                    text: Some(text.to_string()),
                    source: Some("bluebubbles".to_string()),
                    metadata: Some(serde_json::json!({
                        "messageGuid": guid,
                        "chatGuid": channel_id,
                    })),
                    ..Default::default()
                }))
            }
            Err(e) => {
                error!("Failed to send BlueBubbles message: {}", e);
                Err(elizaos::Error::ServiceError(format!(
                    "Failed to send message: {}",
                    e
                )))
            }
        }
    }
}
