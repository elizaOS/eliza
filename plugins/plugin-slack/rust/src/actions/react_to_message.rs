//! React to message action for Slack.

use crate::service::SlackService;
use crate::types::is_valid_message_ts;
use serde::{Deserialize, Serialize};

/// Action name
pub const REACT_TO_MESSAGE_ACTION: &str = "SLACK_REACT_TO_MESSAGE";

/// Action similes
pub const REACT_TO_MESSAGE_SIMILES: &[&str] = &[
    "ADD_SLACK_REACTION",
    "REACT_SLACK",
    "SLACK_EMOJI",
];

/// Action description
pub const REACT_TO_MESSAGE_DESCRIPTION: &str = "Add or remove an emoji reaction to a Slack message";

/// React to message parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactToMessageParams {
    pub emoji: String,
    pub message_ts: String,
    pub channel_id: String,
    #[serde(default)]
    pub remove: bool,
}

/// React to message result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactToMessageResult {
    pub success: bool,
    pub action: Option<String>,
    pub error: Option<String>,
}

/// Execute the react to message action
pub async fn execute_react_to_message(
    service: &SlackService,
    params: ReactToMessageParams,
) -> ReactToMessageResult {
    if !is_valid_message_ts(&params.message_ts) {
        return ReactToMessageResult {
            success: false,
            action: None,
            error: Some("Invalid message timestamp format".to_string()),
        };
    }

    let result = if params.remove {
        service.remove_reaction(&params.channel_id, &params.message_ts, &params.emoji).await
    } else {
        service.add_reaction(&params.channel_id, &params.message_ts, &params.emoji).await
    };

    match result {
        Ok(()) => ReactToMessageResult {
            success: true,
            action: Some(if params.remove { "removed" } else { "added" }.to_string()),
            error: None,
        },
        Err(e) => ReactToMessageResult {
            success: false,
            action: None,
            error: Some(e.to_string()),
        },
    }
}
