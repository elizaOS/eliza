//! Send reaction action for the BlueBubbles plugin.

use crate::service::BlueBubblesService;
use crate::types::BlueBubblesSendResult;
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Parameters for the send reaction action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionParams {
    /// The chat GUID.
    pub chat_guid: String,
    /// The message GUID to react to.
    pub message_guid: String,
    /// The emoji reaction.
    pub emoji: String,
    /// Whether to remove the reaction.
    #[serde(default)]
    pub remove: bool,
}

/// Execute the send reaction action.
pub async fn execute_send_reaction(
    service: &BlueBubblesService,
    params: SendReactionParams,
) -> BlueBubblesSendResult {
    if !service.is_connected() {
        return BlueBubblesSendResult::failure("BlueBubbles service is not connected");
    }

    let result = service
        .send_reaction(
            &params.chat_guid,
            &params.message_guid,
            &params.emoji,
            params.remove,
        )
        .await;

    if result.success {
        let action = if params.remove { "Removed" } else { "Added" };
        debug!("{} reaction {} on {}", action, params.emoji, params.message_guid);
    }

    result
}

/// Action definition for send reaction.
pub const SEND_REACTION_ACTION: &str = "BLUEBUBBLES_SEND_REACTION";

/// Action similes.
pub const SEND_REACTION_SIMILES: &[&str] = &[
    "BLUEBUBBLES_REACT",
    "BB_REACTION",
    "IMESSAGE_REACT",
];

/// Action description.
pub const SEND_REACTION_DESCRIPTION: &str = "Add or remove a reaction on a message via BlueBubbles";

/// Template for extracting parameters via LLM.
pub const SEND_REACTION_TEMPLATE: &str = r#"# Task: Extract BlueBubbles reaction parameters

Based on the conversation, determine what reaction to add or remove.

Recent conversation:
{{recentMessages}}

Extract the following:
1. emoji: The emoji reaction to add (heart, thumbsup, thumbsdown, haha, exclamation, question, or any emoji)
2. messageId: The message ID to react to (or "last" for the last message)
3. remove: true to remove the reaction, false to add it

Respond with a JSON object:
```json
{
  "emoji": "❤️",
  "messageId": "last",
  "remove": false
}
```
"#;

/// Action struct for send reaction, implementing the Action trait.
pub struct SendReactionAction;

impl SendReactionAction {
    /// Creates a new send reaction action.
    pub fn new() -> Self {
        Self
    }
}

impl Default for SendReactionAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl elizaos::Action for SendReactionAction {
    fn name(&self) -> &str {
        SEND_REACTION_ACTION
    }

    fn description(&self) -> &str {
        SEND_REACTION_DESCRIPTION
    }

    fn similes(&self) -> Vec<&str> {
        SEND_REACTION_SIMILES.to_vec()
    }

    fn examples(&self) -> Vec<Vec<elizaos::ActionExample>> {
        vec![
            vec![
                elizaos::ActionExample {
                    name: "{{user1}}".to_string(),
                    content: elizaos::Content {
                        text: Some("React to that message with a heart".to_string()),
                        ..Default::default()
                    },
                },
                elizaos::ActionExample {
                    name: "{{agentName}}".to_string(),
                    content: elizaos::Content {
                        text: Some("I'll add a heart reaction.".to_string()),
                        action: Some(SEND_REACTION_ACTION.to_string()),
                        ..Default::default()
                    },
                },
            ],
            vec![
                elizaos::ActionExample {
                    name: "{{user1}}".to_string(),
                    content: elizaos::Content {
                        text: Some("Give a thumbs up to the last message".to_string()),
                        ..Default::default()
                    },
                },
                elizaos::ActionExample {
                    name: "{{agentName}}".to_string(),
                    content: elizaos::Content {
                        text: Some("I'll react with a thumbs up.".to_string()),
                        action: Some(SEND_REACTION_ACTION.to_string()),
                        ..Default::default()
                    },
                },
            ],
        ]
    }

    async fn validate(&self, runtime: &dyn elizaos::IAgentRuntime, _message: &elizaos::Memory) -> bool {
        runtime
            .get_service::<BlueBubblesService>(crate::BLUEBUBBLES_SERVICE_NAME)
            .is_some()
    }

    async fn handler(
        &self,
        runtime: &dyn elizaos::IAgentRuntime,
        message: &elizaos::Memory,
        state: Option<&elizaos::State>,
        _options: Option<&serde_json::Value>,
    ) -> elizaos::Result<Option<elizaos::Content>> {
        let service = runtime
            .get_service::<BlueBubblesService>(crate::BLUEBUBBLES_SERVICE_NAME)
            .ok_or_else(|| {
                elizaos::Error::ServiceError("BlueBubbles service not available".to_string())
            })?;

        // Get chat context from state
        let state_data = state
            .and_then(|s| s.data.as_ref())
            .and_then(|d| d.as_object());

        let chat_guid = state_data
            .and_then(|d| d.get("chatGuid"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                elizaos::Error::ValidationError("Could not determine chat".to_string())
            })?;

        let message_guid = state_data
            .and_then(|d| d.get("lastMessageGuid"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                elizaos::Error::ValidationError("Could not find message to react to".to_string())
            })?;

        // Default emoji
        let emoji = "❤️";
        let remove = false;

        let params = SendReactionParams {
            chat_guid: chat_guid.to_string(),
            message_guid: message_guid.to_string(),
            emoji: emoji.to_string(),
            remove,
        };

        let result = execute_send_reaction(service, params).await;

        if !result.success {
            return Err(elizaos::Error::ServiceError(
                result.error.unwrap_or_else(|| "Failed to send reaction".to_string()),
            ));
        }

        Ok(Some(elizaos::Content {
            text: Some(if remove {
                "Reaction removed.".to_string()
            } else {
                format!("Reacted with {}.", emoji)
            }),
            source: Some("bluebubbles".to_string()),
            metadata: Some(serde_json::json!({
                "emoji": emoji,
                "messageGuid": message_guid,
                "removed": remove,
            })),
            ..Default::default()
        }))
    }
}
