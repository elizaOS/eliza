//! KNOWLEDGE provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for knowledge information.
pub struct KnowledgeProvider;

#[async_trait]
impl Provider for KnowledgeProvider {
    fn name(&self) -> &'static str {
        "KNOWLEDGE"
    }

    fn description(&self) -> &'static str {
        "Provides relevant knowledge from the agent's knowledge base based on semantic similarity"
    }

    fn is_dynamic(&self) -> bool {
        true
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

        // Search for relevant knowledge
        match runtime.search_knowledge(query_text, 5).await {
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

                        knowledge_entries.push(serde_json::json!({
                            "id": entry.id.to_string(),
                            "text": knowledge_text,
                            "source": source
                        }));

                        sections.push(format!("- {}", knowledge_text));
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
