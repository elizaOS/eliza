//! Edit message action for Slack.

use crate::service::SlackService;
use crate::types::is_valid_message_ts;
use serde::{Deserialize, Serialize};

/// Action name
pub const EDIT_MESSAGE_ACTION: &str = "SLACK_EDIT_MESSAGE";

/// Action similes
pub const EDIT_MESSAGE_SIMILES: &[&str] = &[
    "UPDATE_SLACK_MESSAGE",
    "MODIFY_MESSAGE",
    "CHANGE_MESSAGE",
];

/// Action description
pub const EDIT_MESSAGE_DESCRIPTION: &str = "Edit an existing Slack message";

/// Edit message parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditMessageParams {
    pub message_ts: String,
    pub new_text: String,
    pub channel_id: String,
}

/// Edit message result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditMessageResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Execute the edit message action
pub async fn execute_edit_message(
    service: &SlackService,
    params: EditMessageParams,
) -> EditMessageResult {
    if !is_valid_message_ts(&params.message_ts) {
        return EditMessageResult {
            success: false,
            error: Some("Invalid message timestamp format".to_string()),
        };
    }

    match service.edit_message(&params.channel_id, &params.message_ts, &params.new_text).await {
        Ok(()) => EditMessageResult {
            success: true,
            error: None,
        },
        Err(e) => EditMessageResult {
            success: false,
            error: Some(e.to_string()),
        },
    }
}
