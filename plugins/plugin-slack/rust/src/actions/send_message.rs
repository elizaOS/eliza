//! Send message action for Slack.

use crate::service::SlackService;
use crate::types::SlackMessageSendOptions;
use serde::{Deserialize, Serialize};

/// Action name
pub const SEND_MESSAGE_ACTION: &str = "SLACK_SEND_MESSAGE";

/// Action similes
pub const SEND_MESSAGE_SIMILES: &[&str] = &[
    "SEND_SLACK_MESSAGE",
    "POST_TO_SLACK",
    "MESSAGE_SLACK",
    "SLACK_POST",
];

/// Action description
pub const SEND_MESSAGE_DESCRIPTION: &str = "Send a message to a Slack channel or thread";

/// Send message parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageParams {
    pub text: String,
    pub channel_id: String,
    pub thread_ts: Option<String>,
}

/// Send message result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub success: bool,
    pub message_ts: Option<String>,
    pub channel_id: Option<String>,
    pub error: Option<String>,
}

/// Execute the send message action
pub async fn execute_send_message(
    service: &SlackService,
    params: SendMessageParams,
) -> SendMessageResult {
    let options = SlackMessageSendOptions {
        thread_ts: params.thread_ts,
        ..Default::default()
    };

    match service.send_message(&params.channel_id, &params.text, Some(options)).await {
        Ok(result) => SendMessageResult {
            success: true,
            message_ts: Some(result.ts),
            channel_id: Some(result.channel_id),
            error: None,
        },
        Err(e) => SendMessageResult {
            success: false,
            message_ts: None,
            channel_id: None,
            error: Some(e.to_string()),
        },
    }
}
