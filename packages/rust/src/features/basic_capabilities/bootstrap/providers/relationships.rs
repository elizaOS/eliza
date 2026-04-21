//! RELATIONSHIPS provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("RELATIONSHIPS"));

/// Provider for entity relationships.
pub struct RelationshipsProvider;

#[async_trait]
impl Provider for RelationshipsProvider {
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
        let entity_id = match message.entity_id {
            Some(id) => id,
            None => {
                return Ok(ProviderResult::new("No relationships found.")
                    .with_value("relationshipCount", 0i64));
            }
        };

        // Get relationships for this entity
        let relationships = runtime
            .get_memories(None, Some(entity_id), None, 50)
            .await
            .unwrap_or_default();

        // Filter for relationship memories (simplified - real impl would query relationships table)
        let relationship_memories: Vec<_> = relationships
            .iter()
            .filter(|m| {
                m.metadata
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(|t| t == "relationship")
                    .unwrap_or(false)
            })
            .collect();

        if relationship_memories.is_empty() {
            return Ok(ProviderResult::new("No relationships found.")
                .with_value("relationshipCount", 0i64));
        }

        let formatted: Vec<String> = relationship_memories
            .iter()
            .take(30)
            .map(|m| {
                let target = m
                    .metadata
                    .get("targetName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown");
                let tags = m
                    .metadata
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                let interactions = m
                    .metadata
                    .get("interactions")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);

                format!(
                    "- {}: tags=[{}], interactions={}",
                    target, tags, interactions
                )
            })
            .collect();

        let sender_name = message.content.text.split(':').next().unwrap_or("Unknown");
        let text = format!(
            "# {} has observed {} interacting with:\n{}",
            runtime.character().name,
            sender_name,
            formatted.join("\n")
        );

        Ok(ProviderResult::new(text)
            .with_value("relationshipCount", relationship_memories.len() as i64)
            .with_data(
                "relationships",
                serde_json::to_value(&relationship_memories).unwrap_or_default(),
            ))
    }
}
