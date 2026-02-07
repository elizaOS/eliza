//! Leave channel action for Twitch plugin.

use crate::service::TwitchService;
use crate::types::normalize_channel;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for leaving a Twitch channel
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaveChannelParams {
    /// The channel to leave (without # prefix)
    pub channel: String,
}

/// Result of leaving a Twitch channel
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaveChannelResult {
    pub success: bool,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the leave channel action
pub async fn execute_leave_channel(
    service: Arc<TwitchService>,
    params: LeaveChannelParams,
) -> LeaveChannelResult {
    let channel = normalize_channel(&params.channel);

    // Check if we're in that channel
    let joined_channels = service.get_joined_channels().await;
    if !joined_channels.contains(&channel) {
        return LeaveChannelResult {
            success: false,
            channel,
            error: Some("Not in that channel".to_string()),
        };
    }

    // Prevent leaving primary channel
    if channel == normalize_channel(service.get_primary_channel()) {
        return LeaveChannelResult {
            success: false,
            channel,
            error: Some("Cannot leave primary channel".to_string()),
        };
    }

    match service.leave_channel(&channel).await {
        Ok(()) => LeaveChannelResult {
            success: true,
            channel,
            error: None,
        },
        Err(e) => LeaveChannelResult {
            success: false,
            channel,
            error: Some(e.to_string()),
        },
    }
}

/// Action metadata
pub const ACTION_NAME: &str = "TWITCH_LEAVE_CHANNEL";
pub const ACTION_DESCRIPTION: &str = "Leave a Twitch channel";
pub const ACTION_SIMILES: &[&str] = &[
    "LEAVE_TWITCH_CHANNEL",
    "EXIT_CHANNEL",
    "PART_CHANNEL",
    "DISCONNECT_CHANNEL",
];
