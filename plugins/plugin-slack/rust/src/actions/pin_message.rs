//! Pin message action for Slack.

use crate::service::SlackService;
use crate::types::is_valid_message_ts;
use serde::{Deserialize, Serialize};

/// Action name
pub const PIN_MESSAGE_ACTION: &str = "SLACK_PIN_MESSAGE";

/// Action similes
pub const PIN_MESSAGE_SIMILES: &[&str] = &[
    "PIN_SLACK_MESSAGE",
    "PIN_MESSAGE",
    "SLACK_PIN",
];

/// Action description
pub const PIN_MESSAGE_DESCRIPTION: &str = "Pin a message in a Slack channel";

/// Pin message parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinMessageParams {
    pub message_ts: String,
    pub channel_id: String,
}

/// Pin message result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinMessageResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Execute the pin message action
pub async fn execute_pin_message(
    service: &SlackService,
    params: PinMessageParams,
) -> PinMessageResult {
    if !is_valid_message_ts(&params.message_ts) {
        return PinMessageResult {
            success: false,
            error: Some("Invalid message timestamp format".to_string()),
        };
    }

    match service.pin_message(&params.channel_id, &params.message_ts).await {
        Ok(()) => PinMessageResult {
            success: true,
            error: None,
        },
        Err(e) => PinMessageResult {
            success: false,
            error: Some(e.to_string()),
        },
    }
}
