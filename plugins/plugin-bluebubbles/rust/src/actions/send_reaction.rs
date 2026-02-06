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
