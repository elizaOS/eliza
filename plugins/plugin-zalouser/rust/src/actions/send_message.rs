//! Send message action for Zalo User.

use serde::{Deserialize, Serialize};

/// Action name constant.
pub const SEND_MESSAGE_ACTION: &str = "SEND_ZALOUSER_MESSAGE";

/// Similar action names.
pub const SEND_MESSAGE_SIMILES: &[&str] = &[
    "ZALOUSER_SEND_MESSAGE",
    "ZALOUSER_REPLY",
    "ZALOUSER_MESSAGE",
    "SEND_ZALO",
    "REPLY_ZALO",
    "ZALO_SEND",
    "ZALO_MESSAGE",
];

/// Send message action description.
pub const SEND_MESSAGE_DESCRIPTION: &str = "Send a message to a Zalo chat via personal account";

/// Send message action parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageActionParams {
    /// Thread ID to send to.
    pub thread_id: String,
    /// Message text.
    pub text: String,
    /// Whether this is a group message.
    #[serde(default)]
    pub is_group: bool,
}

/// Send message action result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageActionResult {
    /// Whether successful.
    pub success: bool,
    /// Action name.
    pub action: String,
    /// Thread ID.
    pub thread_id: String,
    /// Message text sent.
    pub text: String,
    /// Message ID if successful.
    pub message_id: Option<String>,
    /// Error message if failed.
    pub error: Option<String>,
}

/// Validate send message action.
pub fn validate_send_message(source: Option<&str>) -> bool {
    source == Some("zalouser")
}

/// Action metadata for registration.
#[derive(Debug, Clone, Serialize)]
pub struct SendMessageActionMeta {
    /// The action name.
    pub name: &'static str,
    /// Similar action names.
    pub similes: &'static [&'static str],
    /// Description of the action.
    pub description: &'static str,
}

impl Default for SendMessageActionMeta {
    fn default() -> Self {
        Self {
            name: SEND_MESSAGE_ACTION,
            similes: SEND_MESSAGE_SIMILES,
            description: SEND_MESSAGE_DESCRIPTION,
        }
    }
}

/// Get action metadata.
pub fn send_message_action_meta() -> SendMessageActionMeta {
    SendMessageActionMeta::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_send_message() {
        assert!(validate_send_message(Some("zalouser")));
        assert!(!validate_send_message(Some("telegram")));
        assert!(!validate_send_message(None));
    }

    #[test]
    fn test_action_meta() {
        let meta = send_message_action_meta();
        assert_eq!(meta.name, SEND_MESSAGE_ACTION);
        assert!(!meta.similes.is_empty());
    }
}
