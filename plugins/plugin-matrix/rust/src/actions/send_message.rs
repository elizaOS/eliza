//! Send message action for Matrix plugin.

use crate::service::MatrixService;
use crate::types::{
    is_valid_matrix_room_alias, is_valid_matrix_room_id, MatrixMessageSendOptions, MatrixSendResult,
};
use serde::{Deserialize, Serialize};

/// Parameters for the send message action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageParams {
    pub text: String,
    pub room_id: Option<String>,
    pub reply_to: Option<String>,
    pub thread_id: Option<String>,
}

/// Result from the send message action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub success: bool,
    pub event_id: Option<String>,
    pub room_id: Option<String>,
    pub error: Option<String>,
}

impl From<MatrixSendResult> for SendMessageResult {
    fn from(result: MatrixSendResult) -> Self {
        Self {
            success: result.success,
            event_id: result.event_id,
            room_id: result.room_id,
            error: result.error,
        }
    }
}

/// Execute the send message action.
pub async fn execute_send_message(
    service: &MatrixService,
    params: SendMessageParams,
    context_room_id: Option<&str>,
) -> SendMessageResult {
    // Determine target room
    let target_room = if let Some(ref room) = params.room_id {
        if room != "current"
            && (is_valid_matrix_room_id(room) || is_valid_matrix_room_alias(room))
        {
            Some(room.clone())
        } else {
            context_room_id.map(|s| s.to_string())
        }
    } else {
        context_room_id.map(|s| s.to_string())
    };

    let room_id = match target_room {
        Some(id) => id,
        None => {
            return SendMessageResult {
                success: false,
                event_id: None,
                room_id: None,
                error: Some("Could not determine target room".to_string()),
            }
        }
    };

    let options = MatrixMessageSendOptions {
        room_id: Some(room_id),
        reply_to: params.reply_to,
        thread_id: params.thread_id,
        formatted: false,
        media_url: None,
    };

    match service.send_message(&params.text, Some(options)).await {
        Ok(result) => result.into(),
        Err(e) => SendMessageResult {
            success: false,
            event_id: None,
            room_id: None,
            error: Some(e.to_string()),
        },
    }
}
