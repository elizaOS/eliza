//! Send message action for Signal plugin.

use crate::service::SignalService;
use crate::types::{is_valid_group_id, normalize_e164, SignalMessageSendOptions, SignalPluginError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for sending a Signal message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageParams {
    /// The message text to send
    pub text: String,
    /// The recipient phone number (E.164) or group ID
    pub recipient: String,
    /// Whether the recipient is a group
    #[serde(default)]
    pub is_group: bool,
    /// Optional: timestamp of message to quote
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_timestamp: Option<i64>,
    /// Optional: author of message to quote
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_author: Option<String>,
}

/// Result of sending a Signal message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub success: bool,
    pub timestamp: Option<i64>,
    pub recipient: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the send message action
pub async fn execute_send_message(
    service: Arc<SignalService>,
    params: SendMessageParams,
) -> SendMessageResult {
    // Determine recipient type
    let is_group = params.is_group || is_valid_group_id(&params.recipient);

    // Build options
    let options = if params.quote_timestamp.is_some() || params.quote_author.is_some() {
        Some(SignalMessageSendOptions {
            quote_timestamp: params.quote_timestamp,
            quote_author: params.quote_author,
            ..Default::default()
        })
    } else {
        None
    };

    // Send message
    let result = if is_group {
        service
            .send_group_message(&params.recipient, &params.text, options)
            .await
    } else {
        let normalized = match normalize_e164(&params.recipient) {
            Some(n) => n,
            None => {
                return SendMessageResult {
                    success: false,
                    timestamp: None,
                    recipient: params.recipient,
                    error: Some("Invalid phone number format".to_string()),
                };
            }
        };
        service.send_message(&normalized, &params.text, options).await
    };

    match result {
        Ok(res) => SendMessageResult {
            success: true,
            timestamp: Some(res.timestamp),
            recipient: params.recipient,
            error: None,
        },
        Err(e) => SendMessageResult {
            success: false,
            timestamp: None,
            recipient: params.recipient,
            error: Some(e.to_string()),
        },
    }
}

/// Action metadata
pub const ACTION_NAME: &str = "SIGNAL_SEND_MESSAGE";
pub const ACTION_DESCRIPTION: &str = "Send a message to a Signal contact or group";
pub const ACTION_SIMILES: &[&str] = &[
    "SEND_SIGNAL_MESSAGE",
    "TEXT_SIGNAL",
    "MESSAGE_SIGNAL",
    "SIGNAL_TEXT",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_params_serialization() {
        let params = SendMessageParams {
            text: "Hello!".to_string(),
            recipient: "+14155551234".to_string(),
            is_group: false,
            quote_timestamp: None,
            quote_author: None,
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("Hello!"));
        assert!(json.contains("+14155551234"));
    }
}
