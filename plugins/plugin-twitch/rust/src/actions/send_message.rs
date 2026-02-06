//! Send message action for Twitch plugin.

use crate::service::TwitchService;
use crate::types::{normalize_channel, TwitchMessageSendOptions, TwitchPluginError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for sending a Twitch message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageParams {
    /// The message text to send
    pub text: String,
    /// The channel to send to (without # prefix)
    #[serde(default)]
    pub channel: Option<String>,
    /// Message ID to reply to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

/// Result of sending a Twitch message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub success: bool,
    pub channel: String,
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the send message action
pub async fn execute_send_message(
    service: Arc<TwitchService>,
    params: SendMessageParams,
) -> SendMessageResult {
    let channel = params
        .channel
        .as_deref()
        .map(normalize_channel)
        .unwrap_or_else(|| normalize_channel(service.get_primary_channel()));

    let options = TwitchMessageSendOptions {
        channel: Some(channel.clone()),
        reply_to: params.reply_to,
    };

    match service.send_message(&params.text, Some(options)).await {
        Ok(result) => SendMessageResult {
            success: result.success,
            channel,
            message_id: result.message_id,
            error: result.error,
        },
        Err(e) => SendMessageResult {
            success: false,
            channel,
            message_id: None,
            error: Some(e.to_string()),
        },
    }
}

/// Action metadata
pub const ACTION_NAME: &str = "TWITCH_SEND_MESSAGE";
pub const ACTION_DESCRIPTION: &str = "Send a message to a Twitch channel";
pub const ACTION_SIMILES: &[&str] = &[
    "SEND_TWITCH_MESSAGE",
    "TWITCH_CHAT",
    "CHAT_TWITCH",
    "SAY_IN_TWITCH",
];
