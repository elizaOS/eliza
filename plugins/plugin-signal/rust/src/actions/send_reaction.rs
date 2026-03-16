//! Send reaction action for Signal plugin.

use crate::service::SignalService;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Parameters for sending a Signal reaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionParams {
    /// The emoji to react with
    pub emoji: String,
    /// The timestamp of the message to react to
    pub target_timestamp: i64,
    /// The phone number of the message author
    pub target_author: String,
    /// The recipient (phone number or group ID)
    pub recipient: String,
    /// Whether to remove the reaction instead of adding it
    #[serde(default)]
    pub remove: bool,
}

/// Result of sending a Signal reaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionResult {
    pub success: bool,
    pub emoji: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the send reaction action
pub async fn execute_send_reaction(
    service: Arc<SignalService>,
    params: SendReactionParams,
) -> SendReactionResult {
    let result = if params.remove {
        service
            .remove_reaction(
                &params.recipient,
                &params.emoji,
                params.target_timestamp,
                &params.target_author,
            )
            .await
    } else {
        service
            .send_reaction(
                &params.recipient,
                &params.emoji,
                params.target_timestamp,
                &params.target_author,
            )
            .await
    };

    let action = if params.remove { "removed" } else { "added" };

    match result {
        Ok(_) => SendReactionResult {
            success: true,
            emoji: params.emoji,
            action: action.to_string(),
            error: None,
        },
        Err(e) => SendReactionResult {
            success: false,
            emoji: params.emoji,
            action: action.to_string(),
            error: Some(e.to_string()),
        },
    }
}

/// Action metadata
pub const ACTION_NAME: &str = "SIGNAL_SEND_REACTION";
pub const ACTION_DESCRIPTION: &str = "React to a Signal message with an emoji";
pub const ACTION_SIMILES: &[&str] = &[
    "REACT_SIGNAL",
    "SIGNAL_REACT",
    "ADD_SIGNAL_REACTION",
    "SIGNAL_EMOJI",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_params_serialization() {
        let params = SendReactionParams {
            emoji: "👍".to_string(),
            target_timestamp: 1234567890000,
            target_author: "+14155551234".to_string(),
            recipient: "+14155551234".to_string(),
            remove: false,
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("👍"));
        assert!(json.contains("1234567890000"));
    }
}
