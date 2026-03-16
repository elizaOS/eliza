//! Delete message action for Slack.

use crate::service::SlackService;
use crate::types::is_valid_message_ts;
use serde::{Deserialize, Serialize};

/// Action name
pub const DELETE_MESSAGE_ACTION: &str = "SLACK_DELETE_MESSAGE";

/// Action similes
pub const DELETE_MESSAGE_SIMILES: &[&str] = &[
    "REMOVE_SLACK_MESSAGE",
    "DELETE_MESSAGE",
    "SLACK_REMOVE",
];

/// Action description
pub const DELETE_MESSAGE_DESCRIPTION: &str = "Delete a Slack message";

/// Delete message parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteMessageParams {
    pub message_ts: String,
    pub channel_id: String,
}

/// Delete message result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteMessageResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Execute the delete message action
pub async fn execute_delete_message(
    service: &SlackService,
    params: DeleteMessageParams,
) -> DeleteMessageResult {
    if !is_valid_message_ts(&params.message_ts) {
        return DeleteMessageResult {
            success: false,
            error: Some("Invalid message timestamp format".to_string()),
        };
    }

    match service.delete_message(&params.channel_id, &params.message_ts).await {
        Ok(()) => DeleteMessageResult {
            success: true,
            error: None,
        },
        Err(e) => DeleteMessageResult {
            success: false,
            error: Some(e.to_string()),
        },
    }
}
