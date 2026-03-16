//! Send flex message action for the LINE plugin.

use crate::service::LineService;
use crate::types::*;
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Parameters for sending a LINE flex message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendFlexMessageParams {
    /// Alternative text for notifications
    pub alt_text: String,
    /// Card title
    pub title: String,
    /// Card body
    pub body: String,
    /// Target user/group/room ID
    pub to: String,
}

/// Result of the send flex message action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendFlexMessageResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Create a simple info card bubble
fn create_info_bubble(title: &str, body: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": title,
                    "weight": "bold",
                    "size": "xl",
                    "wrap": true
                },
                {
                    "type": "text",
                    "text": body,
                    "margin": "md",
                    "wrap": true
                }
            ]
        }
    })
}

/// Execute the send flex message action
pub async fn execute_send_flex_message(
    service: &LineService,
    params: SendFlexMessageParams,
) -> SendFlexMessageResult {
    // Check connection
    if !service.is_connected().await {
        return SendFlexMessageResult {
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
            return SendFlexMessageResult {
                success: false,
                to: None,
                message_id: None,
                error: Some("Invalid target ID".to_string()),
            }
        }
    };

    // Create flex message
    let flex_message = LineFlexMessage {
        alt_text: params.alt_text[..params.alt_text.len().min(400)].to_string(),
        contents: create_info_bubble(&params.title, &params.body),
    };

    // Send message
    let result = service.send_flex_message(&target, flex_message).await;

    if !result.success {
        return SendFlexMessageResult {
            success: false,
            to: Some(target),
            message_id: None,
            error: result.error,
        };
    }

    debug!("Sent LINE flex message to {}", target);

    SendFlexMessageResult {
        success: true,
        to: Some(target),
        message_id: result.message_id,
        error: None,
    }
}

/// Action metadata
pub const SEND_FLEX_MESSAGE_ACTION_NAME: &str = "LINE_SEND_FLEX_MESSAGE";
pub const SEND_FLEX_MESSAGE_ACTION_DESCRIPTION: &str = "Send a rich flex message/card via LINE";
pub const SEND_FLEX_MESSAGE_ACTION_SIMILES: &[&str] = &[
    "SEND_LINE_CARD",
    "LINE_FLEX",
    "LINE_CARD",
    "SEND_LINE_FLEX",
];
