//! FOLLOW_ROOM action implementation.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{PluginError, PluginResult};
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Content, Memory, MemoryType, State};

use super::Action;

/// Action for following a room.
pub struct FollowRoomAction;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Action for FollowRoomAction {
    fn name(&self) -> &'static str {
        "FOLLOW_ROOM"
    }

    fn similes(&self) -> &[&'static str] {
        &["JOIN_ROOM", "SUBSCRIBE_ROOM", "WATCH_ROOM", "ENTER_ROOM"]
    }

    fn description(&self) -> &'static str {
        "Follow a room to receive updates and monitor messages. \
         Use this when you want to actively engage with a room's content."
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        let Some(room_id) = message.room_id else {
            return false;
        };

        // Check if room exists
        let Ok(Some(room)) = runtime.get_room(room_id).await else {
            return false;
        };

        // Check if already following
        if let Some(world_id) = room.world_id {
            if let Ok(Some(world)) = runtime.get_world(world_id).await {
                if let Some(followed) = world.metadata.get("followedRooms") {
                    if let Some(arr) = followed.as_array() {
                        let room_str = room_id.to_string();
                        if arr.iter().any(|v| v.as_str() == Some(&room_str)) {
                            return false; // Already following
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
            PluginError::InvalidInput("No room specified to follow".to_string())
        })?;

        let room = runtime
            .get_room(room_id)
            .await?
            .ok_or_else(|| PluginError::NotFound("Room not found".to_string()))?;

        let room_name = room.name.clone().unwrap_or_else(|| "Unknown Room".to_string());

        // Update world's followed rooms
        if let Some(world_id) = room.world_id {
            if let Some(mut world) = runtime.get_world(world_id).await? {
                let mut followed: Vec<String> = world
                    .metadata
                    .get("followedRooms")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                let room_str = room_id.to_string();
                if !followed.contains(&room_str) {
                    followed.push(room_str);
                    world.metadata.insert(
                        "followedRooms".to_string(),
                        serde_json::json!(followed),
                    );
                    runtime.update_world(&world).await?;
                }
            }
        }

        // Create memory of the action
        let mut metadata = HashMap::new();
        metadata.insert("type".to_string(), serde_json::json!("FOLLOW_ROOM"));
        metadata.insert("roomName".to_string(), serde_json::json!(&room_name));

        runtime
            .create_memory(
                Content {
                    text: format!("Now following room: {}", room_name),
                    actions: vec!["FOLLOW_ROOM".to_string()],
                    ..Default::default()
                },
                Some(room_id),
                Some(runtime.agent_id()),
                MemoryType::Action,
                metadata,
            )
            .await?;

        Ok(ActionResult::success(format!("Now following room: {}", room_name))
            .with_value("success", true)
            .with_value("following", true)
            .with_value("roomId", room_id.to_string())
            .with_value("roomName", room_name.clone())
            .with_data("actionName", "FOLLOW_ROOM")
            .with_data("roomId", room_id.to_string())
            .with_data("roomName", room_name))
    }
}

