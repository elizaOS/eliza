use anyhow::Result;
use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Weak;

use crate::runtime::AgentRuntime;
use crate::types::components::{ActionDefinition, ActionHandler, ActionResult, HandlerOptions};
use crate::types::environment::RoomMetadata;
use crate::types::memory::Memory;
use crate::types::state::State;

/// Resets session context by advancing the room compaction marker.
pub struct ResetSessionAction {
    runtime: Weak<AgentRuntime>,
}

impl ResetSessionAction {
    pub fn new(runtime: Weak<AgentRuntime>) -> Self {
        Self { runtime }
    }
}

#[async_trait]
impl ActionHandler for ResetSessionAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "RESET_SESSION".to_string(),
            description: "Resets the conversation session by creating a compaction point. Messages before this point will not be included in future context.".to_string(),
            similes: Some(vec![
                "CLEAR_HISTORY".to_string(),
                "NEW_SESSION".to_string(),
                "FORGET".to_string(),
                "START_OVER".to_string(),
                "RESET".to_string(),
            ]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let Some(runtime) = self.runtime.upgrade() else {
            return false;
        };
        let Some(adapter) = runtime.get_adapter() else {
            return false;
        };

        let room = match adapter.get_room(&message.room_id).await {
            Ok(room) => room,
            Err(_) => return false,
        };

        let Some(room) = room else {
            return true;
        };

        let Some(world_id) = room.world_id else {
            return true;
        };

        let world = match adapter.get_world(&world_id).await {
            Ok(world) => world,
            Err(_) => return false,
        };

        let Some(world) = world else {
            return true;
        };

        let role = world
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.roles.get(message.entity_id.as_str()))
            .map(String::as_str);

        matches!(role, Some("OWNER") | Some("ADMIN"))
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let Some(runtime) = self.runtime.upgrade() else {
            return Ok(Some(
                ActionResult::failure("Runtime no longer available")
                    .with_data("actionName", "RESET_SESSION"),
            ));
        };

        let Some(adapter) = runtime.get_adapter() else {
            return Ok(Some(
                ActionResult::failure("No database adapter configured")
                    .with_data("actionName", "RESET_SESSION"),
            ));
        };

        let Some(mut room) = adapter.get_room(&message.room_id).await? else {
            return Ok(Some(
                ActionResult::failure("Room not found")
                    .with_value("error", "room_not_found")
                    .with_data("actionName", "RESET_SESSION"),
            ));
        };

        let now = current_time_ms();
        let metadata = room.metadata.get_or_insert_with(|| RoomMetadata {
            values: HashMap::new(),
        });
        let previous_compaction = metadata.values.get("lastCompactionAt").cloned();

        let mut compaction_history = metadata
            .values
            .get("compactionHistory")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        compaction_history.push(json!({
            "timestamp": now,
            "triggeredBy": message.entity_id.to_string(),
            "reason": "manual_reset",
        }));
        if compaction_history.len() > 10 {
            let drain_count = compaction_history.len() - 10;
            compaction_history.drain(0..drain_count);
        }

        metadata
            .values
            .insert("lastCompactionAt".to_string(), json!(now));
        metadata
            .values
            .insert("compactionHistory".to_string(), json!(compaction_history));

        runtime.update_room(&room).await?;

        let mut result = ActionResult::success("Session reset successfully")
            .with_value("success", true)
            .with_value("compactionAt", now)
            .with_value("roomId", room.id.to_string())
            .with_data("actionName", "RESET_SESSION")
            .with_data("compactionAt", now)
            .with_data("roomId", room.id.to_string());

        if let Some(previous) = previous_compaction {
            result = result.with_value("previousCompactionAt", previous);
        }

        Ok(Some(result))
    }
}

fn current_time_ms() -> i64 {
    let now = std::time::SystemTime::now();
    let duration = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    duration.as_millis() as i64
}
