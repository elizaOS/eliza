//! Send reaction action for Matrix plugin.

use crate::service::MatrixService;
use crate::types::MatrixSendResult;
use serde::{Deserialize, Serialize};

/// Parameters for the send reaction action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionParams {
    pub emoji: String,
    pub event_id: String,
    pub room_id: Option<String>,
}

/// Result from the send reaction action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionResult {
    pub success: bool,
    pub event_id: Option<String>,
    pub emoji: String,
    pub error: Option<String>,
}

impl From<(MatrixSendResult, String)> for SendReactionResult {
    fn from((result, emoji): (MatrixSendResult, String)) -> Self {
        Self {
            success: result.success,
            event_id: result.event_id,
            emoji,
            error: result.error,
        }
    }
}

/// Execute the send reaction action.
pub async fn execute_send_reaction(
    service: &MatrixService,
    params: SendReactionParams,
    context_room_id: Option<&str>,
) -> SendReactionResult {
    // Determine room ID
    let room_id = params
        .room_id
        .as_deref()
        .or(context_room_id)
        .map(|s| s.to_string());

    let room_id = match room_id {
        Some(id) => id,
        None => {
            return SendReactionResult {
                success: false,
                event_id: None,
                emoji: params.emoji,
                error: Some("Could not determine room".to_string()),
            }
        }
    };

    match service
        .send_reaction(&room_id, &params.event_id, &params.emoji)
        .await
    {
        Ok(result) => (result, params.emoji).into(),
        Err(e) => SendReactionResult {
            success: false,
            event_id: None,
            emoji: params.emoji,
            error: Some(e.to_string()),
        },
    }
}
