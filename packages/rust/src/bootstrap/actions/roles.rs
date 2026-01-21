//! UPDATE_ROLE action implementation.

use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{PluginError, PluginResult};
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;
use crate::generated::spec_helpers::require_action_spec;
use crate::prompts::UPDATE_ROLE_TEMPLATE;
use once_cell::sync::Lazy;

/// Action for updating entity roles.
pub struct UpdateRoleAction;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("UPDATE_ROLE"));

#[async_trait]
impl Action for UpdateRoleAction {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn similes(&self) -> &[&'static str] {
        static SIMILES: Lazy<Box<[&'static str]>> = Lazy::new(|| {
            SPEC.similes
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .into_boxed_slice()
        });
        &SIMILES
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        let Some(room_id) = message.room_id else {
            return false;
        };

        // Check if room exists and has a world
        let Ok(Some(room)) = runtime.get_room(room_id).await else {
            return false;
        };

        let Some(world_id) = room.world_id else {
            return false;
        };

        // Check if agent has permission to update roles
        let Ok(Some(world)) = runtime.get_world(world_id).await else {
            return false;
        };

        if let Some(metadata) = world.metadata.as_ref() {
            let agent_id = runtime.agent_id().to_string();
            if let Some(role) = metadata.roles.get(&agent_id) {
                return role == "OWNER" || role == "ADMIN";
            }
        }

        false
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let _state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for UPDATE_ROLE action".to_string())
        })?;

        let room_id = message.room_id.ok_or_else(|| {
            PluginError::InvalidInput("No room context for role update".to_string())
        })?;

        let room = runtime
            .get_room(room_id)
            .await?
            .ok_or_else(|| PluginError::NotFound("Room not found".to_string()))?;

        let world_id = room
            .world_id
            .ok_or_else(|| PluginError::InvalidInput("Room has no world".to_string()))?;

        let world = runtime
            .get_world(world_id)
            .await?
            .ok_or_else(|| PluginError::NotFound("World not found".to_string()))?;

        // Compose state
        let composed_state = runtime
            .compose_state(message, &["RECENT_MESSAGES", "ACTION_STATE", "WORLD_INFO"])
            .await?;

        // Get template
        let template = runtime
            .character()
            .templates
            .get("updateRoleTemplate")
            .map(|s| s.as_str())
            .unwrap_or(UPDATE_ROLE_TEMPLATE);

        let prompt = runtime.compose_prompt(&composed_state, template);

        // Call the model
        let response = runtime
            .use_model(ModelType::TextLarge, ModelParams::with_prompt(&prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let response_text = response
            .as_text()
            .ok_or_else(|| PluginError::ModelError("Expected text response".to_string()))?;

        // Parse XML response
        let parsed = parse_key_value_xml(response_text)
            .ok_or_else(|| PluginError::XmlParse("Failed to parse response XML".to_string()))?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let entity_id_str = parsed
            .get("entity_id")
            .cloned()
            .ok_or_else(|| PluginError::InvalidInput("No entity ID provided".to_string()))?;
        let new_role_str = parsed
            .get("new_role")
            .cloned()
            .ok_or_else(|| PluginError::InvalidInput("No role provided".to_string()))?
            .to_uppercase();

        // Validate entity ID
        let entity_id = Uuid::parse_str(&entity_id_str).map_err(|_| {
            PluginError::InvalidInput(format!("Invalid entity ID: {}", entity_id_str))
        })?;

        // Validate role
        match new_role_str.as_str() {
            "OWNER" | "ADMIN" | "MEMBER" | "GUEST" | "NONE" => {}
            _ => {
                return Err(PluginError::InvalidInput(format!(
                    "Invalid role: {}",
                    new_role_str
                )))
            }
        }

        // Get old role
        let old_role = world
            .metadata
            .as_ref()
            .and_then(|m| m.roles.get(&entity_id_str).cloned())
            .unwrap_or_else(|| "NONE".to_string());

        // Update role in world
        let mut updated_world = world.clone();
        let metadata = updated_world.metadata.get_or_insert_with(Default::default);
        metadata
            .roles
            .insert(entity_id_str.clone(), new_role_str.clone());
        runtime.update_world(&updated_world).await?;

        Ok(ActionResult::success(format!(
            "Role updated: {} is now {}",
            entity_id_str, new_role_str
        ))
        .with_value("success", true)
        .with_value("roleUpdated", true)
        .with_value("entityId", entity_id_str.clone())
        .with_value("oldRole", old_role.clone())
        .with_value("newRole", new_role_str.clone())
        .with_data("actionName", "UPDATE_ROLE")
        .with_data("entityId", entity_id_str)
        .with_data("oldRole", old_role)
        .with_data("newRole", new_role_str)
        .with_data("thought", thought))
    }
}
