//! Read channel action for Slack.

use crate::service::SlackService;
use crate::types::SlackMessage;
use serde::{Deserialize, Serialize};

/// Action name
pub const READ_CHANNEL_ACTION: &str = "SLACK_READ_CHANNEL";

/// Action similes
pub const READ_CHANNEL_SIMILES: &[&str] = &[
    "READ_SLACK_MESSAGES",
    "GET_CHANNEL_HISTORY",
    "SLACK_HISTORY",
];

/// Action description
pub const READ_CHANNEL_DESCRIPTION: &str = "Read message history from a Slack channel";

/// Read channel parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadChannelParams {
    pub channel_id: String,
    pub limit: Option<i32>,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// Read channel result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadChannelResult {
    pub success: bool,
    pub messages: Vec<SlackMessage>,
    pub message_count: usize,
    pub error: Option<String>,
}

/// Execute the read channel action
pub async fn execute_read_channel(
    service: &SlackService,
    params: ReadChannelParams,
) -> ReadChannelResult {
    let limit = params.limit.map(|l| l.min(100)).unwrap_or(10);

    match service
        .read_history(
            &params.channel_id,
            Some(limit),
            params.before.as_deref(),
            params.after.as_deref(),
        )
        .await
    {
        Ok(messages) => {
            let message_count = messages.len();
            ReadChannelResult {
                success: true,
                messages,
                message_count,
                error: None,
            }
        }
        Err(e) => ReadChannelResult {
            success: false,
            messages: vec![],
            message_count: 0,
            error: Some(e.to_string()),
        },
    }
}
