//! Room state provider for Matrix plugin.

use crate::service::MatrixService;
use crate::types::{get_matrix_localpart, MatrixRoom};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Room state data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomStateData {
    pub room_id: Option<String>,
    pub room_name: Option<String>,
    pub is_encrypted: bool,
    pub is_direct: bool,
    pub member_count: usize,
    pub user_id: String,
    pub display_name: String,
    pub homeserver: String,
    pub connected: bool,
}

/// Room state provider result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomStateProviderResult {
    pub data: RoomStateData,
    pub values: HashMap<String, serde_json::Value>,
    pub text: String,
}

/// Get the current Matrix room state.
pub fn get_room_state(
    service: &MatrixService,
    room: Option<&MatrixRoom>,
    agent_name: &str,
) -> RoomStateProviderResult {
    let user_id = service.get_user_id().to_string();
    let display_name = get_matrix_localpart(&user_id).to_string();
    let homeserver = service.get_homeserver().to_string();

    let (room_id, room_name, is_encrypted, is_direct, member_count) = room
        .map(|r| {
            (
                Some(r.room_id.clone()),
                r.name.clone(),
                r.is_encrypted,
                r.is_direct,
                r.member_count,
            )
        })
        .unwrap_or((None, None, false, false, 0));

    // Build response text
    let mut response_text = if is_direct {
        format!("{} is in a direct message conversation on Matrix.", agent_name)
    } else {
        let room_label = room_name
            .as_ref()
            .or(room_id.as_ref())
            .map(|s| s.as_str())
            .unwrap_or("a Matrix room");
        let mut text = format!("{} is currently in Matrix room \"{}\".", agent_name, room_label);
        if member_count > 0 {
            text.push_str(&format!(" The room has {} members.", member_count));
        }
        text
    };

    if is_encrypted {
        response_text.push_str(" This room has end-to-end encryption enabled.");
    }

    response_text.push_str(&format!(
        "\n\nMatrix is a decentralized communication protocol. {} is logged in as {}.",
        agent_name, user_id
    ));

    let data = RoomStateData {
        room_id: room_id.clone(),
        room_name: room_name.clone(),
        is_encrypted,
        is_direct,
        member_count,
        user_id: user_id.clone(),
        display_name: display_name.clone(),
        homeserver,
        connected: true,
    };

    let mut values = HashMap::new();
    if let Some(ref id) = room_id {
        values.insert("room_id".to_string(), serde_json::json!(id));
    }
    if let Some(ref name) = room_name {
        values.insert("room_name".to_string(), serde_json::json!(name));
    }
    values.insert("is_encrypted".to_string(), serde_json::json!(is_encrypted));
    values.insert("is_direct".to_string(), serde_json::json!(is_direct));
    values.insert("member_count".to_string(), serde_json::json!(member_count));
    values.insert("user_id".to_string(), serde_json::json!(user_id));

    RoomStateProviderResult {
        data,
        values,
        text: response_text,
    }
}
