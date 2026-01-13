use async_trait::async_trait;
use log::error;

use super::{KnowledgeProviderTrait, ProviderContext, ProviderResult};
use crate::types::KnowledgeItem;

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
            .enumerate()
            .map(|(i, item)| {
                let similarity = item
                    .similarity
                    .map(|s| format!(" (relevance: {:.2})", s))
                    .unwrap_or_default();

                format!("{}. {}{}", i + 1, item.content, similarity)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn add_header(header: &str, content: &str) -> String {
        if content.is_empty() {
            String::new()
        } else {
            format!("{}\n\n{}", header, content)
        }
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
        "Retrieves knowledge from the knowledge base for RAG"
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
                data: serde_json::json!({ "knowledge": [], "count": 0 }),
                values: serde_json::json!({
                    "knowledgeCount": 0,
                    "knowledge": "",
                    "relevantKnowledge": "",
                }),
                text: String::new(),
            };
        }

        let item_refs: Vec<&KnowledgeItem> = items.iter().collect();
        let knowledge_list = self.format_items(&item_refs);
        let knowledge_text = Self::add_header("# Relevant Knowledge", &knowledge_list);

        let knowledge_data: Vec<serde_json::Value> = items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "id": item.id,
                    "content": item.content,
                    "similarity": item.similarity,
                })
            })
            .collect();

        ProviderResult {
            data: serde_json::json!({
                "knowledge": knowledge_data,
                "count": items.len(),
            }),
            values: serde_json::json!({
                "knowledgeCount": items.len(),
                "knowledge": knowledge_list,
                "relevantKnowledge": knowledge_text,
            }),
            text: knowledge_text,
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

        assert!(formatted.contains("1. First knowledge"));
        assert!(formatted.contains("(relevance: 0.95)"));
        assert!(formatted.contains("2. Second knowledge"));
        assert!(formatted.contains("(relevance: 0.87)"));
    }

    #[test]
    fn test_format_items_empty() {
        let provider = KnowledgeProvider::new();
        let items: Vec<&KnowledgeItem> = vec![];
        let formatted = provider.format_items(&items);
        assert!(formatted.is_empty());
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

        assert_eq!(result.data["count"], 0);
        assert!(result.text.is_empty());
    }
}
