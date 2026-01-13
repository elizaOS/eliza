//! MUTE_ROOM action implementation.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{PluginError, PluginResult};
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Content, Memory, MemoryType, State};

use super::Action;

/// Action for muting a room.
pub struct MuteRoomAction;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Action for MuteRoomAction {
    fn name(&self) -> &'static str {
        "MUTE_ROOM"
    }

    fn similes(&self) -> &[&'static str] {
        &["SILENCE_ROOM", "QUIET_ROOM", "DISABLE_NOTIFICATIONS", "STOP_RESPONDING"]
    }

    fn description(&self) -> &'static str {
        "Mute a room to stop responding and receiving notifications. \
         Use this when you want to stop interacting with a room temporarily."
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        let Some(room_id) = message.room_id else {
            return false;
        };

        // Check if room exists
        let Ok(Some(room)) = runtime.get_room(room_id).await else {
            return false;
        };

        // Check if not already muted
        if let Some(world_id) = room.world_id {
            if let Ok(Some(world)) = runtime.get_world(world_id).await {
                if let Some(muted) = world.metadata.get("mutedRooms") {
                    if let Some(arr) = muted.as_array() {
                        let room_str = room_id.to_string();
                        if arr.iter().any(|v| v.as_str() == Some(&room_str)) {
                            return false; // Already muted
                        }
                    }
                }
            }
        }

        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        _state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let room_id = message.room_id.ok_or_else(|| {
            PluginError::InvalidInput("No room specified to mute".to_string())
        })?;

        let room = runtime
            .get_room(room_id)
            .await?
            .ok_or_else(|| PluginError::NotFound("Room not found".to_string()))?;

        let room_name = room.name.clone().unwrap_or_else(|| "Unknown Room".to_string());

        // Update world's muted rooms
        if let Some(world_id) = room.world_id {
            if let Some(mut world) = runtime.get_world(world_id).await? {
                let mut muted: Vec<String> = world
                    .metadata
                    .get("mutedRooms")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                let room_str = room_id.to_string();
                if !muted.contains(&room_str) {
                    muted.push(room_str);
                    world.metadata.insert(
                        "mutedRooms".to_string(),
                        serde_json::json!(muted),
                    );
                    runtime.update_world(&world).await?;
                }
            }
        }

        // Create memory of the action
        let mut metadata = HashMap::new();
        metadata.insert("type".to_string(), serde_json::json!("MUTE_ROOM"));
        metadata.insert("roomName".to_string(), serde_json::json!(&room_name));

        runtime
            .create_memory(
                Content {
                    text: format!("Muted room: {}", room_name),
                    actions: vec!["MUTE_ROOM".to_string()],
                    ..Default::default()
                },
                Some(room_id),
                Some(runtime.agent_id()),
                MemoryType::Action,
                metadata,
            )
            .await?;

        Ok(ActionResult::success(format!("Muted room: {}", room_name))
            .with_value("success", true)
            .with_value("muted", true)
            .with_value("roomId", room_id.to_string())
            .with_value("roomName", room_name.clone())
            .with_data("actionName", "MUTE_ROOM")
            .with_data("roomId", room_id.to_string())
            .with_data("roomName", room_name))
    }
}

