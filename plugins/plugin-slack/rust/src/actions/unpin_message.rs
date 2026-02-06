//! Unpin message action for Slack.

use crate::service::SlackService;
use crate::types::is_valid_message_ts;
use serde::{Deserialize, Serialize};

/// Action name
pub const UNPIN_MESSAGE_ACTION: &str = "SLACK_UNPIN_MESSAGE";

/// Action similes
pub const UNPIN_MESSAGE_SIMILES: &[&str] = &[
    "UNPIN_SLACK_MESSAGE",
    "UNPIN_MESSAGE",
    "SLACK_UNPIN",
];

/// Action description
pub const UNPIN_MESSAGE_DESCRIPTION: &str = "Unpin a message from a Slack channel";

/// Unpin message parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnpinMessageParams {
    pub message_ts: String,
    pub channel_id: String,
}

/// Unpin message result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnpinMessageResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Execute the unpin message action
pub async fn execute_unpin_message(
    service: &SlackService,
    params: UnpinMessageParams,
) -> UnpinMessageResult {
    if !is_valid_message_ts(&params.message_ts) {
        return UnpinMessageResult {
            success: false,
            error: Some("Invalid message timestamp format".to_string()),
        };
    }

    match service.unpin_message(&params.channel_id, &params.message_ts).await {
        Ok(()) => UnpinMessageResult {
            success: true,
            error: None,
        },
        Err(e) => UnpinMessageResult {
            success: false,
            error: Some(e.to_string()),
        },
    }
}
