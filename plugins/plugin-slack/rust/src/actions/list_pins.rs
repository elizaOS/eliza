//! List pins action for Slack.

use crate::service::SlackService;
use crate::types::SlackMessage;
use serde::{Deserialize, Serialize};

/// Action name
pub const LIST_PINS_ACTION: &str = "SLACK_LIST_PINS";

/// Action similes
pub const LIST_PINS_SIMILES: &[&str] = &[
    "LIST_SLACK_PINS",
    "SHOW_PINS",
    "GET_PINNED_MESSAGES",
];

/// Action description
pub const LIST_PINS_DESCRIPTION: &str = "List pinned messages in a Slack channel";

/// List pins parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListPinsParams {
    pub channel_id: String,
}

/// List pins result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListPinsResult {
    pub success: bool,
    pub pins: Vec<PinInfo>,
    pub pin_count: usize,
    pub error: Option<String>,
}

/// Pin info for listing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinInfo {
    pub ts: String,
    pub user: Option<String>,
    pub text: String,
}

impl From<SlackMessage> for PinInfo {
    fn from(msg: SlackMessage) -> Self {
        Self {
            ts: msg.ts,
            user: msg.user,
            text: msg.text,
        }
    }
}

/// Execute the list pins action
pub async fn execute_list_pins(
    service: &SlackService,
    params: ListPinsParams,
) -> ListPinsResult {
    match service.list_pins(&params.channel_id).await {
        Ok(messages) => {
            let pins: Vec<PinInfo> = messages.into_iter().map(PinInfo::from).collect();
            let pin_count = pins.len();
            
            ListPinsResult {
                success: true,
                pins,
                pin_count,
                error: None,
            }
        }
        Err(e) => ListPinsResult {
            success: false,
            pins: vec![],
            pin_count: 0,
            error: Some(e.to_string()),
        },
    }
}
