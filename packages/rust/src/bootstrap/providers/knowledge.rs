//! KNOWLEDGE provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::database::SearchMemoriesParams;
use crate::types::{Memory, MemoryType, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("KNOWLEDGE"));

/// Provider for knowledge information.
pub struct KnowledgeProvider;

#[async_trait]
impl Provider for KnowledgeProvider {
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
        let query_text = &message.content.text;

        if query_text.is_empty() {
            return Ok(ProviderResult::new("")
                .with_value("knowledgeCount", 0)
                .with_value("hasKnowledge", false)
                .with_data("entries", Vec::<serde_json::Value>::new()));
        }

        let mut sections = Vec::new();
        let mut knowledge_entries: Vec<serde_json::Value> = Vec::new();

        // 1. Fetch recent messages to get embeddings
        let recent_messages = match runtime
            .get_memories(Some(message.room_id), None, None, 5)
            .await
        {
            Ok(msgs) => msgs,
            Err(e) => {
                runtime.log_warning(
                    "provider:knowledge",
                    &format!("Error fetching recent messages: {}", e),
                );
                Vec::new()
            }
        };

        // 2. Extract valid embeddings
        let embeddings: Vec<Vec<f32>> = recent_messages
            .into_iter()
            .filter_map(|m| m.embedding)
            .filter(|v| !v.is_empty())
            .collect();

        // 3. Search using the most recent embedding if available
        if let Some(primary_embedding) = embeddings.first() {
            let params = SearchMemoriesParams {
                table_name: "knowledge".to_string(),
                room_id: message.room_id,
                embedding: primary_embedding.clone(),
                match_threshold: 0.75,
                match_count: 5,
                unique: Some(true),
            };

            match runtime.search_memories(params).await {
                Ok(entries) => {
                    for entry in entries {
                        if !entry.content.text.is_empty() {
                            let mut knowledge_text = entry.content.text.clone();
                            if knowledge_text.len() > 500 {
                                knowledge_text.truncate(500);
                                knowledge_text.push_str("...");
                            }

                            let source = entry
                                .metadata
                                .get("source")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();

                            // Avoid duplicates
                            let id_str = entry.id.to_string();
                            if !knowledge_entries.iter().any(|e| e["id"] == id_str) {
                                knowledge_entries.push(serde_json::json!({
                                    "id": id_str,
                                    "text": knowledge_text,
                                    "source": source
                                }));
                                sections.push(format!("- {}", knowledge_text));
                            }
                        }
                    }
                }
                Err(e) => {
                     runtime.log_warning(
                        "provider:knowledge",
                        &format!("Error searching knowledge: {}", e),
                    );
                }
            }
        }

        let context_text = if sections.is_empty() {
            String::new()
        } else {
            format!("# Relevant Knowledge\n{}", sections.join("\n"))
        };

        Ok(ProviderResult::new(context_text)
            .with_value("knowledgeCount", knowledge_entries.len() as i64)
            .with_value("hasKnowledge", !knowledge_entries.is_empty())
            .with_data("entries", knowledge_entries)
            .with_data("query", query_text.clone()))
    }
}
