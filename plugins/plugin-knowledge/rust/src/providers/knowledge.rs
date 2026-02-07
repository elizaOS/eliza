use async_trait::async_trait;
use log::error;

use super::{KnowledgeProviderTrait, ProviderContext, ProviderResult};
use crate::types::{KnowledgeItem, RAGMetadata, RetrievedFragmentInfo};

pub struct KnowledgeProvider {
    items: Vec<KnowledgeItem>,
}

impl KnowledgeProvider {
    pub fn new() -> Self {
        Self { items: Vec::new() }
    }

    pub fn update_items(&mut self, items: Vec<KnowledgeItem>) {
        self.items = items;
    }

    pub fn format_items(&self, items: &[&KnowledgeItem]) -> String {
        if items.is_empty() {
            return String::new();
        }

        items
            .iter()
            .map(|item| format!("- {}", item.content))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn add_header(header: &str, content: &str) -> String {
        if content.is_empty() {
            String::new()
        } else {
            format!("{}\n\n{}", header, content)
        }
    }

    /// Build RAG metadata from knowledge items and a query.
    pub fn build_rag_metadata(items: &[KnowledgeItem], query_text: &str) -> Option<RAGMetadata> {
        if items.is_empty() {
            return None;
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Some(RAGMetadata {
            retrieved_fragments: items
                .iter()
                .map(|item| {
                    let doc_title = item
                        .metadata
                        .get("filename")
                        .and_then(|v| v.as_str())
                        .or_else(|| item.metadata.get("title").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string();

                    let preview = if item.content.len() > 100 {
                        format!("{}...", &item.content[..100])
                    } else {
                        item.content.clone()
                    };

                    RetrievedFragmentInfo {
                        fragment_id: item.id.clone(),
                        document_title: doc_title,
                        similarity_score: item.similarity,
                        content_preview: preview,
                    }
                })
                .collect(),
            query_text: query_text.to_string(),
            total_fragments: items.len(),
            retrieval_timestamp: now,
            used_in_response: true,
        })
    }
}

impl Default for KnowledgeProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl KnowledgeProviderTrait for KnowledgeProvider {
    fn name(&self) -> &'static str {
        "KNOWLEDGE"
    }

    fn description(&self) -> &'static str {
        "Knowledge from the knowledge base that the agent knows, retrieved whenever the agent needs to answer a question about their expertise."
    }

    fn dynamic(&self) -> bool {
        true
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let items_value = context.state.get("knowledgeItems");

        let items: Vec<KnowledgeItem> = items_value
            .and_then(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|e| {
                        error!("Failed to deserialize knowledge items: {}", e);
                        e
                    })
                    .ok()
            })
            .unwrap_or_else(|| self.items.clone());

        if items.is_empty() {
            return ProviderResult {
                data: serde_json::json!({
                    "knowledge": "",
                    "ragMetadata": null,
                    "knowledgeUsed": false,
                }),
                values: serde_json::json!({
                    "knowledge": "",
                    "knowledgeUsed": false,
                }),
                text: String::new(),
            };
        }

        // Take first 5 items for context
        let first_five: Vec<&KnowledgeItem> = items.iter().take(5).collect();
        let knowledge_list = self.format_items(&first_five);
        let knowledge_text = Self::add_header("# Knowledge", &knowledge_list);

        // Truncate if too long (4000 tokens * 3.5 chars/token)
        let max_chars = (4000.0 * 3.5) as usize;
        let knowledge = if knowledge_text.len() > max_chars {
            knowledge_text[..max_chars].to_string()
        } else {
            knowledge_text
        };

        // Build RAG metadata
        let query_text = context.query.as_deref().unwrap_or("");
        let rag_metadata = Self::build_rag_metadata(&items, query_text);

        let rag_json = rag_metadata
            .as_ref()
            .map(|r| serde_json::to_value(r).unwrap_or(serde_json::Value::Null))
            .unwrap_or(serde_json::Value::Null);

        ProviderResult {
            data: serde_json::json!({
                "knowledge": &knowledge,
                "ragMetadata": rag_json,
                "knowledgeUsed": true,
            }),
            values: serde_json::json!({
                "knowledge": &knowledge,
                "knowledgeUsed": true,
            }),
            text: knowledge,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn create_test_item(content: &str, similarity: f64) -> KnowledgeItem {
        KnowledgeItem {
            id: format!("item-{}", content.len()),
            content: content.to_string(),
            metadata: HashMap::new(),
            embedding: None,
            similarity: Some(similarity),
        }
    }

    #[test]
    fn test_format_items() {
        let provider = KnowledgeProvider::new();

        let item1 = create_test_item("First knowledge item content", 0.95);
        let item2 = create_test_item("Second knowledge item content", 0.87);

        let items: Vec<&KnowledgeItem> = vec![&item1, &item2];
        let formatted = provider.format_items(&items);

        assert!(formatted.contains("- First knowledge"));
        assert!(formatted.contains("- Second knowledge"));
    }

    #[test]
    fn test_format_items_empty() {
        let provider = KnowledgeProvider::new();
        let items: Vec<&KnowledgeItem> = vec![];
        let formatted = provider.format_items(&items);
        assert!(formatted.is_empty());
    }

    #[test]
    fn test_build_rag_metadata() {
        let items = vec![
            create_test_item("AI content", 0.95),
            create_test_item("ML content", 0.85),
        ];

        let rag = KnowledgeProvider::build_rag_metadata(&items, "AI query");
        assert!(rag.is_some());

        let rag = rag.unwrap();
        assert_eq!(rag.retrieved_fragments.len(), 2);
        assert_eq!(rag.query_text, "AI query");
        assert_eq!(rag.total_fragments, 2);
        assert!(rag.retrieval_timestamp > 0);
    }

    #[test]
    fn test_build_rag_metadata_empty() {
        let items: Vec<KnowledgeItem> = vec![];
        let rag = KnowledgeProvider::build_rag_metadata(&items, "query");
        assert!(rag.is_none());
    }

    #[tokio::test]
    async fn test_get_empty() {
        let provider = KnowledgeProvider::new();
        let context = ProviderContext {
            agent_id: uuid::Uuid::new_v4(),
            entity_id: None,
            room_id: None,
            query: None,
            state: serde_json::json!({}),
        };

        let result = provider.get(&context).await;

        assert_eq!(result.data["knowledgeUsed"], false);
        assert!(result.text.is_empty());
    }

    #[tokio::test]
    async fn test_get_with_items() {
        let mut provider = KnowledgeProvider::new();
        provider.update_items(vec![
            create_test_item("Knowledge about AI", 0.95),
            create_test_item("Knowledge about ML", 0.85),
        ]);

        let context = ProviderContext {
            agent_id: uuid::Uuid::new_v4(),
            entity_id: None,
            room_id: None,
            query: Some("AI query".to_string()),
            state: serde_json::json!({}),
        };

        let result = provider.get(&context).await;

        assert_eq!(result.data["knowledgeUsed"], true);
        assert!(!result.text.is_empty());
        assert!(result.text.contains("Knowledge about AI"));
        assert!(result.data["ragMetadata"].is_object());
    }
}
