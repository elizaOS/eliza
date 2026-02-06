//! Join room action for Matrix plugin.

use crate::service::MatrixService;
use crate::types::{is_valid_matrix_room_alias, is_valid_matrix_room_id};
use serde::{Deserialize, Serialize};

/// Parameters for the join room action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinRoomParams {
    pub room: String,
}

/// Result from the join room action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinRoomResult {
    pub success: bool,
    pub room_id: Option<String>,
    pub joined: Option<String>,
    pub error: Option<String>,
}

/// Execute the join room action.
pub async fn execute_join_room(
    service: &MatrixService,
    params: JoinRoomParams,
) -> JoinRoomResult {
    // Validate room identifier
    if !is_valid_matrix_room_id(&params.room) && !is_valid_matrix_room_alias(&params.room) {
        return JoinRoomResult {
            success: false,
            room_id: None,
            joined: None,
            error: Some(format!("Invalid room identifier: {}", params.room)),
        };
    }

    match service.join_room(&params.room).await {
        Ok(room_id) => JoinRoomResult {
            success: true,
            room_id: Some(room_id),
            joined: Some(params.room),
            error: None,
        },
        Err(e) => JoinRoomResult {
            success: false,
            room_id: None,
            joined: None,
            error: Some(e.to_string()),
        },
    }
}
