//! Join channel action for Twitch plugin.

use crate::service::TwitchService;
use crate::types::normalize_channel;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for joining a Twitch channel
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinChannelParams {
    /// The channel to join (without # prefix)
    pub channel: String,
}

/// Result of joining a Twitch channel
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinChannelResult {
    pub success: bool,
    pub channel: String,
    #[serde(default)]
    pub already_joined: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the join channel action
pub async fn execute_join_channel(
    service: Arc<TwitchService>,
    params: JoinChannelParams,
) -> JoinChannelResult {
    let channel = normalize_channel(&params.channel);

    // Check if already joined
    let joined_channels = service.get_joined_channels().await;
    if joined_channels.contains(&channel) {
        return JoinChannelResult {
            success: true,
            channel,
            already_joined: true,
            error: None,
        };
    }

    match service.join_channel(&channel).await {
        Ok(()) => JoinChannelResult {
            success: true,
            channel,
            already_joined: false,
            error: None,
        },
        Err(e) => JoinChannelResult {
            success: false,
            channel,
            already_joined: false,
            error: Some(e.to_string()),
        },
    }
}

/// Action metadata
pub const ACTION_NAME: &str = "TWITCH_JOIN_CHANNEL";
pub const ACTION_DESCRIPTION: &str = "Join a Twitch channel to listen and send messages";
pub const ACTION_SIMILES: &[&str] = &[
    "JOIN_TWITCH_CHANNEL",
    "ENTER_CHANNEL",
    "CONNECT_CHANNEL",
];
