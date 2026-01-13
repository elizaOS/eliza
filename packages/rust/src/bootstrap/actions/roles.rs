//! UPDATE_ROLE action implementation.

use async_trait::async_trait;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{PluginError, PluginResult};
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{ActionResult, Memory, ModelType, Role, State};
use crate::xml::parse_key_value_xml;

use super::Action;

const UPDATE_ROLE_TEMPLATE: &str = r#"# Task: Update entity role in the world.

{{providers}}

# Current Role Assignments:
{{roles}}

# Instructions:
Based on the request, determine the role assignment to make.
Valid roles are: OWNER, ADMIN, MEMBER, GUEST, NONE

Respond using XML format like this:
<response>
    <thought>Your reasoning for the role change</thought>
    <entity_id>The entity ID to update</entity_id>
    <new_role>The new role to assign (OWNER, ADMIN, MEMBER, GUEST, or NONE)</new_role>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."#;

/// Action for updating entity roles.
pub struct UpdateRoleAction;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Action for UpdateRoleAction {
    fn name(&self) -> &'static str {
        "UPDATE_ROLE"
    }

    fn similes(&self) -> &[&'static str] {
        &["ASSIGN_ROLE", "CHANGE_ROLE", "SET_ROLE", "MODIFY_PERMISSIONS", "GRANT_ROLE"]
    }

    fn description(&self) -> &'static str {
        "Update the role of an entity in a world. \
         Use this to manage permissions and access levels."
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

        if let Some(roles) = world.metadata.get("roles") {
            if let Some(roles_obj) = roles.as_object() {
                let agent_id = runtime.agent_id().to_string();
                if let Some(role) = roles_obj.get(&agent_id) {
                    let role_str = role.as_str().unwrap_or("NONE");
                    return role_str == "OWNER" || role_str == "ADMIN";
                }
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

        let world_id = room.world_id.ok_or_else(|| {
            PluginError::InvalidInput("Room has no world".to_string())
        })?;

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
        let new_role: Role = match new_role_str.as_str() {
            "OWNER" => Role::Owner,
            "ADMIN" => Role::Admin,
            "MEMBER" => Role::Member,
            "GUEST" => Role::Guest,
            "NONE" => Role::None,
            _ => return Err(PluginError::InvalidInput(format!("Invalid role: {}", new_role_str))),
        };

        // Get old role
        let old_role = world
            .metadata
            .get("roles")
            .and_then(|r| r.as_object())
            .and_then(|o| o.get(&entity_id_str))
            .and_then(|r| r.as_str())
            .unwrap_or("NONE")
            .to_string();

        // Update role in world
        let mut updated_world = world.clone();
        let roles = updated_world
            .metadata
            .entry("roles".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(roles_obj) = roles.as_object_mut() {
            roles_obj.insert(entity_id_str.clone(), serde_json::json!(new_role_str));
        }
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

