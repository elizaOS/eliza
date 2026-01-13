//! ROLES provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for entity roles.
pub struct RolesProvider;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Provider for RolesProvider {
    fn name(&self) -> &'static str {
        "ROLES"
    }

    fn description(&self) -> &'static str {
        "Roles assigned to entities in the current context"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let mut role_info: Vec<serde_json::Value> = Vec::new();

        // Get world context if available
        let world_id = state
            .and_then(|s| s.values.get("worldId"))
            .and_then(|v| v.as_str())
            .and_then(|s| uuid::Uuid::parse_str(s).ok());

        // Try to get from room if no world in state
        let world_id = if world_id.is_none() {
            if let Some(room_id) = message.room_id {
                runtime
                    .get_room(room_id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|r| r.world_id)
            } else {
                None
            }
        } else {
            world_id
        };

        if let Some(wid) = world_id {
            if let Ok(Some(world)) = runtime.get_world(wid).await {
                if let Some(roles) = world.metadata.get("roles") {
                    if let Some(roles_obj) = roles.as_object() {
                        for (entity_id, role) in roles_obj {
                            let entity_name = if let Ok(id) = uuid::Uuid::parse_str(entity_id) {
                                runtime
                                    .get_entity(id)
                                    .await
                                    .ok()
                                    .flatten()
                                    .and_then(|e| e.name)
                                    .unwrap_or_else(|| entity_id[..8].to_string())
                            } else {
                                entity_id[..8.min(entity_id.len())].to_string()
                            };

                            role_info.push(serde_json::json!({
                                "entityId": entity_id,
                                "entityName": entity_name,
                                "role": role
                            }));
                        }
                    }
                }
            }
        }

        // Also include sender's role if known
        if let Some(entity_id) = message.entity_id {
            if let Ok(Some(entity)) = runtime.get_entity(entity_id).await {
                if let Some(role) = entity.metadata.get("role") {
                    let existing = role_info
                        .iter()
                        .any(|r| r.get("entityId").and_then(|v| v.as_str()) == Some(&entity_id.to_string()));

                    if !existing {
                        role_info.push(serde_json::json!({
                            "entityId": entity_id.to_string(),
                            "entityName": entity.name.unwrap_or_else(|| "Unknown".to_string()),
                            "role": role
                        }));
                    }
                }
            }
        }

        if role_info.is_empty() {
            return Ok(ProviderResult::new("")
                .with_value("roleCount", 0i64));
        }

        let formatted: Vec<String> = role_info
            .iter()
            .map(|r| {
                let name = r.get("entityName").and_then(|v| v.as_str()).unwrap_or("Unknown");
                let role = r.get("role").and_then(|v| v.as_str()).unwrap_or("none");
                format!("- {}: {}", name, role)
            })
            .collect();

        let text = format!("# Entity Roles\n{}", formatted.join("\n"));

        Ok(ProviderResult::new(text)
            .with_value("roleCount", role_info.len() as i64)
            .with_data("roles", serde_json::to_value(&role_info).unwrap_or_default()))
    }
}


