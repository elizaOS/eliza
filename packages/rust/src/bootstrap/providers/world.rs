//! WORLD provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("WORLD"));

/// Provider for world/server context.
pub struct WorldProvider;

#[async_trait]
impl Provider for WorldProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(true)
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let Some(room_id) = message.room_id else {
            return Ok(ProviderResult::new("")
                .with_value("hasWorld", false)
                .with_data("error", "no_room_id"));
        };

        let Some(room) = runtime.get_room(room_id).await? else {
            return Ok(ProviderResult::new("")
                .with_value("hasWorld", false)
                .with_value("roomId", room_id.to_string()));
        };

        let Some(world_id) = room.world_id else {
            return Ok(ProviderResult::new("")
                .with_value("hasWorld", false)
                .with_value("roomId", room_id.to_string()));
        };

        let Some(world) = runtime.get_world(world_id).await? else {
            return Ok(ProviderResult::new("")
                .with_value("hasWorld", false)
                .with_value("roomId", room_id.to_string()));
        };

        let mut sections = Vec::new();

        // World name and description
        let world_name = world.name.clone().unwrap_or_else(|| "Unknown".to_string());
        sections.push(format!("# World: {}", world_name));

        if let Some(desc) = world.metadata.get("description").and_then(|v| v.as_str()) {
            sections.push(format!("\n{}", desc));
        }

        // Room info
        let room_name = room.name.clone().unwrap_or_else(|| "Unknown".to_string());
        sections.push(format!("\n## Current Room: {}", room_name));

        if let Some(topic) = room.metadata.get("topic").and_then(|v| v.as_str()) {
            sections.push(format!("Topic: {}", topic));
        }

        // Member count
        let member_count = world
            .metadata
            .get("members")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);

        sections.push(format!("\n## Members: {}", member_count));

        let context_text = sections.join("\n");

        Ok(ProviderResult::new(context_text)
            .with_value("hasWorld", true)
            .with_value("worldId", world_id.to_string())
            .with_value("worldName", world_name.clone())
            .with_value("roomId", room_id.to_string())
            .with_value("roomName", room_name.clone())
            .with_value("memberCount", member_count as i64)
            .with_data(
                "world",
                serde_json::json!({
                    "id": world_id.to_string(),
                    "name": world_name
                }),
            )
            .with_data(
                "room",
                serde_json::json!({
                    "id": room_id.to_string(),
                    "name": room_name
                }),
            ))
    }
}
