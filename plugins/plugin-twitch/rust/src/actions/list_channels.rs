//! List channels action for Twitch plugin.

use crate::service::TwitchService;
use crate::types::{format_channel_for_display, normalize_channel};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for listing Twitch channels (none required)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListChannelsParams {}

/// Result of listing Twitch channels
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListChannelsResult {
    pub success: bool,
    pub channel_count: usize,
    pub channels: Vec<String>,
    pub primary_channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the list channels action
pub async fn execute_list_channels(
    service: Arc<TwitchService>,
    _params: ListChannelsParams,
) -> ListChannelsResult {
    let joined_channels = service.get_joined_channels().await;
    let primary_channel = normalize_channel(service.get_primary_channel());

    ListChannelsResult {
        success: true,
        channel_count: joined_channels.len(),
        channels: joined_channels,
        primary_channel,
        error: None,
    }
}

/// Format channels as a human-readable string
pub fn format_channels_text(result: &ListChannelsResult) -> String {
    if !result.success {
        return format!(
            "Failed to list channels: {}",
            result.error.as_deref().unwrap_or("Unknown error")
        );
    }

    if result.channels.is_empty() {
        return "Not currently in any channels.".to_string();
    }

    let mut lines = vec![format!("Currently in {} channel(s):", result.channel_count)];

    for channel in &result.channels {
        let display = format_channel_for_display(channel);
        let is_primary = channel == &result.primary_channel;
        if is_primary {
            lines.push(format!("• {} (primary)", display));
        } else {
            lines.push(format!("• {}", display));
        }
    }

    lines.join("\n")
}

/// Action metadata
pub const ACTION_NAME: &str = "TWITCH_LIST_CHANNELS";
pub const ACTION_DESCRIPTION: &str = "List all Twitch channels the bot is currently in";
pub const ACTION_SIMILES: &[&str] = &[
    "LIST_TWITCH_CHANNELS",
    "SHOW_CHANNELS",
    "GET_CHANNELS",
    "CURRENT_CHANNELS",
];
