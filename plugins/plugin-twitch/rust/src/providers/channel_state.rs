//! Channel state provider for Twitch plugin.

use crate::service::TwitchService;
use crate::types::{format_channel_for_display, normalize_channel};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Channel state data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStateData {
    pub channel: String,
    pub display_channel: String,
    pub is_primary_channel: bool,
    pub bot_username: String,
    pub joined_channels: Vec<String>,
    pub channel_count: usize,
    pub connected: bool,
}

/// Channel state values (simple key-value)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStateValues {
    pub channel: String,
    pub display_channel: String,
    pub is_primary_channel: bool,
    pub bot_username: String,
    pub channel_count: usize,
}

/// Channel state provider result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStateResult {
    pub data: ChannelStateData,
    pub values: ChannelStateValues,
    pub text: String,
}

/// Get the current Twitch channel state
pub async fn get_channel_state(
    service: Arc<TwitchService>,
    channel: Option<&str>,
    agent_name: &str,
) -> ChannelStateResult {
    let channel = channel
        .map(normalize_channel)
        .unwrap_or_else(|| normalize_channel(service.get_primary_channel()));

    let joined_channels = service.get_joined_channels().await;
    let is_primary_channel = channel == normalize_channel(service.get_primary_channel());
    let bot_username = service.get_bot_username().to_string();
    let display_channel = format_channel_for_display(&channel);
    let connected = service.is_connected().await;

    let mut text = format!(
        "{} is currently in Twitch channel {}.",
        agent_name, display_channel
    );

    if is_primary_channel {
        text.push_str(" This is the primary channel.");
    }

    text.push_str("\n\nTwitch is a live streaming platform. Chat messages are public and visible to all viewers.");
    text.push_str(&format!(" {} is logged in as @{}.", agent_name, bot_username));
    text.push_str(&format!(
        " Currently connected to {} channel(s).",
        joined_channels.len()
    ));

    ChannelStateResult {
        data: ChannelStateData {
            channel: channel.clone(),
            display_channel: display_channel.clone(),
            is_primary_channel,
            bot_username: bot_username.clone(),
            joined_channels,
            channel_count: service.get_joined_channels().await.len(),
            connected,
        },
        values: ChannelStateValues {
            channel,
            display_channel,
            is_primary_channel,
            bot_username,
            channel_count: service.get_joined_channels().await.len(),
        },
        text,
    }
}

/// Provider metadata
pub const PROVIDER_NAME: &str = "twitchChannelState";
pub const PROVIDER_DESCRIPTION: &str = "Provides information about the current Twitch channel context";
