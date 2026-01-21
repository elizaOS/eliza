//! UPDATE_ENTITY action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{PluginError, PluginResult};
use crate::generated::spec_helpers::require_action_spec;
use crate::prompts::UPDATE_ENTITY_TEMPLATE;
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;

/// Action for updating entity information.
pub struct UpdateEntityAction;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("UPDATE_ENTITY"));

#[async_trait]
impl Action for UpdateEntityAction {
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

    async fn validate(&self, _runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        message.entity_id.is_some()
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let _state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for UPDATE_ENTITY action".to_string())
        })?;

        let entity_id = message.entity_id.ok_or_else(|| {
            PluginError::InvalidInput("No entity specified to update".to_string())
        })?;

        let entity = runtime
            .get_entity(entity_id)
            .await?
            .ok_or_else(|| PluginError::NotFound("Entity not found".to_string()))?;

        // Compose state
        let composed_state = runtime
            .compose_state(message, &["RECENT_MESSAGES", "ACTION_STATE", "ENTITY_INFO"])
            .await?;

        // Build entity info for prompt
        let entity_info = format!(
            "Entity ID: {}\nName: {}\nType: {}",
            entity.id,
            entity.name.as_deref().unwrap_or("Unknown"),
            entity.entity_type.as_deref().unwrap_or("Unknown")
        );

        // Get template and compose prompt
        let template = runtime
            .character()
            .templates
            .get("updateEntityTemplate")
            .map(|s| s.as_str())
            .unwrap_or(UPDATE_ENTITY_TEMPLATE);

        let prompt = runtime
            .compose_prompt(&composed_state, template)
            .replace("{{entityInfo}}", &entity_info);

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
        let target_entity_id_str = parsed
            .get("entity_id")
            .cloned()
            .unwrap_or_else(|| entity_id.to_string());
        let field_name = parsed.get("field_name").cloned();
        let field_value = parsed.get("field_value").cloned();

        // Validate target entity ID
        let target_entity_id = Uuid::parse_str(&target_entity_id_str).map_err(|_| {
            PluginError::InvalidInput(format!("Invalid entity ID: {}", target_entity_id_str))
        })?;

        if let (Some(name), Some(value)) = (field_name.clone(), field_value.clone()) {
            // Update entity metadata
            let mut updated_entity = entity.clone();
            updated_entity
                .metadata
                .insert(name.clone(), serde_json::json!(value));
            runtime.update_entity(&updated_entity).await?;

            Ok(
                ActionResult::success(format!("Updated entity field: {}", name))
                    .with_value("success", true)
                    .with_value("entityUpdated", true)
                    .with_value("entityId", target_entity_id.to_string())
                    .with_value("updatedField", name.clone())
                    .with_data("actionName", "UPDATE_ENTITY")
                    .with_data("entityId", target_entity_id.to_string())
                    .with_data("fieldName", name)
                    .with_data("fieldValue", value)
                    .with_data("thought", thought),
            )
        } else {
            Ok(ActionResult::success("No fields to update")
                .with_value("success", true)
                .with_value("noChanges", true)
                .with_data("actionName", "UPDATE_ENTITY")
                .with_data("thought", thought))
        }
    }
}
