//! Send message action for the LINE plugin.

use crate::service::LineService;
use crate::types::*;
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Parameters for sending a LINE message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageParams {
    /// Message text to send
    pub text: String,
    /// Target user/group/room ID
    pub to: String,
}

/// Result of the send message action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the send message action
pub async fn execute_send_message(service: &LineService, params: SendMessageParams) -> SendMessageResult {
    // Check connection
    if !service.is_connected().await {
        return SendMessageResult {
            success: false,
            to: None,
            message_id: None,
            error: Some("LINE service not connected".to_string()),
        };
    }

    // Validate target
    let target = match normalize_line_target(&params.to) {
        Some(t) if is_valid_line_id(&t) => t,
        _ => {
            return SendMessageResult {
                success: false,
                to: None,
                message_id: None,
                error: Some("Invalid target ID".to_string()),
            }
        }
    };

    // Send message
    let result = service.send_message(&target, &params.text).await;

    if !result.success {
        return SendMessageResult {
            success: false,
            to: Some(target),
            message_id: None,
            error: result.error,
        };
    }

    debug!("Sent LINE message to {}", target);

    SendMessageResult {
        success: true,
        to: Some(target),
        message_id: result.message_id,
        error: None,
    }
}

/// Action metadata
pub const SEND_MESSAGE_ACTION_NAME: &str = "LINE_SEND_MESSAGE";
pub const SEND_MESSAGE_ACTION_DESCRIPTION: &str = "Send a text message via LINE";
pub const SEND_MESSAGE_ACTION_SIMILES: &[&str] = &[
    "SEND_LINE_MESSAGE",
    "LINE_MESSAGE",
    "LINE_TEXT",
    "MESSAGE_LINE",
];
