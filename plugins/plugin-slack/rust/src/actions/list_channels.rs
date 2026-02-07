//! List channels action for Slack.

use crate::service::SlackService;
use crate::types::SlackChannel;
use serde::{Deserialize, Serialize};

/// Action name
pub const LIST_CHANNELS_ACTION: &str = "SLACK_LIST_CHANNELS";

/// Action similes
pub const LIST_CHANNELS_SIMILES: &[&str] = &[
    "LIST_SLACK_CHANNELS",
    "SHOW_CHANNELS",
    "GET_CHANNELS",
];

/// Action description
pub const LIST_CHANNELS_DESCRIPTION: &str = "List available Slack channels in the workspace";

/// List channels result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListChannelsResult {
    pub success: bool,
    pub channels: Vec<ChannelInfo>,
    pub channel_count: usize,
    pub error: Option<String>,
}

/// Channel info for listing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
    pub is_private: bool,
    pub num_members: Option<i32>,
    pub topic: Option<String>,
    pub purpose: Option<String>,
}

impl From<SlackChannel> for ChannelInfo {
    fn from(ch: SlackChannel) -> Self {
        Self {
            id: ch.id,
            name: ch.name,
            is_private: ch.is_private,
            num_members: ch.num_members,
            topic: ch.topic.map(|t| t.value),
            purpose: ch.purpose.map(|p| p.value),
        }
    }
}

/// Execute the list channels action
pub async fn execute_list_channels(service: &SlackService) -> ListChannelsResult {
    match service.list_channels(Some("public_channel,private_channel"), Some(100)).await {
        Ok(channels) => {
            let channels: Vec<ChannelInfo> = channels
                .into_iter()
                .filter(|ch| !ch.is_archived)
                .map(ChannelInfo::from)
                .collect();
            
            let channel_count = channels.len();
            
            ListChannelsResult {
                success: true,
                channels,
                channel_count,
                error: None,
            }
        }
        Err(e) => ListChannelsResult {
            success: false,
            channels: vec![],
            channel_count: 0,
            error: Some(e.to_string()),
        },
    }
}
