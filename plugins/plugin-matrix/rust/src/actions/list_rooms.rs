//! List rooms action for Matrix plugin.

use crate::service::MatrixService;
use crate::types::MatrixRoom;
use serde::{Deserialize, Serialize};

/// Result from the list rooms action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListRoomsResult {
    pub success: bool,
    pub room_count: usize,
    pub rooms: Vec<RoomInfo>,
    pub formatted_text: String,
}

/// Room information for display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub room_id: String,
    pub name: Option<String>,
    pub alias: Option<String>,
    pub member_count: usize,
    pub is_encrypted: bool,
}

impl From<MatrixRoom> for RoomInfo {
    fn from(room: MatrixRoom) -> Self {
        Self {
            room_id: room.room_id,
            name: room.name,
            alias: room.canonical_alias,
            member_count: room.member_count,
            is_encrypted: room.is_encrypted,
        }
    }
}

/// Execute the list rooms action.
pub async fn execute_list_rooms(service: &MatrixService) -> ListRoomsResult {
    let rooms = service.get_joined_rooms().await;

    let room_infos: Vec<RoomInfo> = rooms.into_iter().map(|r| r.into()).collect();

    // Format room list
    let formatted = if room_infos.is_empty() {
        "Not currently in any rooms.".to_string()
    } else {
        let room_lines: Vec<String> = room_infos
            .iter()
            .map(|room| {
                let name = room
                    .name
                    .as_ref()
                    .or(room.alias.as_ref())
                    .map(|s| s.as_str())
                    .unwrap_or(&room.room_id);
                let encrypted = if room.is_encrypted { " 🔒" } else { "" };
                format!("• {} ({} members){}", name, room.member_count, encrypted)
            })
            .collect();

        format!(
            "Joined {} room(s):\n\n{}",
            room_infos.len(),
            room_lines.join("\n")
        )
    };

    ListRoomsResult {
        success: true,
        room_count: room_infos.len(),
        rooms: room_infos,
        formatted_text: formatted,
    }
}
