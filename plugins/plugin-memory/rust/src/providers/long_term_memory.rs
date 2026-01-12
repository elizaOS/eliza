use async_trait::async_trait;
use std::collections::HashMap;
use tracing::error;

use super::{MemoryProvider, ProviderContext, ProviderResult};
use crate::types::{LongTermMemory, LongTermMemoryCategory};

/// Provider for long-term persistent memories.
///
/// This provider retrieves and formats long-term memories about users,
/// including facts, preferences, and other persistent information
/// extracted from previous conversations.
pub struct LongTermMemoryProvider;

impl LongTermMemoryProvider {
    /// Creates a new `LongTermMemoryProvider`.
    pub fn new() -> Self {
        Self
    }

    /// Formats a collection of long-term memories into a displayable string.
    ///
    /// Memories are grouped by category and formatted as a bulleted list.
    pub fn format_memories(&self, memories: &[LongTermMemory]) -> String {
        if memories.is_empty() {
            return String::new();
        }

        let mut grouped: HashMap<LongTermMemoryCategory, Vec<&LongTermMemory>> = HashMap::new();
        for memory in memories {
            grouped.entry(memory.category).or_default().push(memory);
        }

        let mut sections = Vec::new();
        for (category, category_memories) in grouped {
            let category_name = match category {
                LongTermMemoryCategory::Episodic => "Episodic",
                LongTermMemoryCategory::Semantic => "Semantic",
                LongTermMemoryCategory::Procedural => "Procedural",
            };

            let items: Vec<String> = category_memories
                .iter()
                .map(|m| format!("- {}", m.content))
                .collect();

            sections.push(format!("**{}**:\n{}", category_name, items.join("\n")));
        }

        sections.join("\n\n")
    }

    fn add_header(header: &str, content: &str) -> String {
        if content.is_empty() {
            String::new()
        } else {
            format!("{}\n\n{}", header, content)
        }
    }

    fn get_category_counts(memories: &[LongTermMemory]) -> String {
        let mut counts: HashMap<LongTermMemoryCategory, i32> = HashMap::new();
        for memory in memories {
            *counts.entry(memory.category).or_insert(0) += 1;
        }

        counts
            .into_iter()
            .map(|(cat, count)| format!("{}: {}", cat, count))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

impl Default for LongTermMemoryProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MemoryProvider for LongTermMemoryProvider {
    fn name(&self) -> &'static str {
        "LONG_TERM_MEMORY"
    }

    fn description(&self) -> &'static str {
        "Persistent facts and preferences about the user"
    }

    fn position(&self) -> i32 {
        50
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        if context.entity_id == context.agent_id {
            return ProviderResult {
                data: serde_json::json!({ "memoryCount": 0 }),
                values: serde_json::json!({ "longTermMemories": "" }),
                text: String::new(),
            };
        }

        let memories_value = context.state.get("longTermMemories");

        let memories: Vec<LongTermMemory> = memories_value
            .and_then(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|e| {
                        error!("Failed to deserialize long-term memories: {}", e);
                        e
                    })
                    .ok()
            })
            .unwrap_or_default();

        if memories.is_empty() {
            return ProviderResult {
                data: serde_json::json!({ "memoryCount": 0 }),
                values: serde_json::json!({ "longTermMemories": "" }),
                text: String::new(),
            };
        }

        let formatted = self.format_memories(&memories);
        let text = Self::add_header("# What I Know About You", &formatted);
        let category_list = Self::get_category_counts(&memories);

        ProviderResult {
            data: serde_json::json!({
                "memoryCount": memories.len(),
                "categories": category_list,
            }),
            values: serde_json::json!({
                "longTermMemories": text,
                "memoryCategories": category_list,
            }),
            text,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    fn create_test_memory(category: LongTermMemoryCategory, content: &str) -> LongTermMemory {
        LongTermMemory {
            id: Uuid::new_v4(),
            agent_id: Uuid::new_v4(),
            entity_id: Uuid::new_v4(),
            category,
            content: content.to_string(),
            metadata: serde_json::json!({}),
            embedding: None,
            confidence: 0.95,
            source: Some("conversation".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            last_accessed_at: None,
            access_count: 0,
            similarity: None,
        }
    }

    #[test]
    fn test_format_memories() {
        let provider = LongTermMemoryProvider::new();

        let memories = vec![
            create_test_memory(LongTermMemoryCategory::Semantic, "User is a Rust developer"),
            create_test_memory(LongTermMemoryCategory::Semantic, "User prefers async/await"),
            create_test_memory(
                LongTermMemoryCategory::Episodic,
                "User mentioned working on a CLI",
            ),
        ];

        let formatted = provider.format_memories(&memories);

        assert!(formatted.contains("**Semantic**"));
        assert!(formatted.contains("- User is a Rust developer"));
        assert!(formatted.contains("- User prefers async/await"));
        assert!(formatted.contains("**Episodic**"));
        assert!(formatted.contains("- User mentioned working on a CLI"));
    }

    #[test]
    fn test_format_memories_empty() {
        let provider = LongTermMemoryProvider::new();
        let memories: Vec<LongTermMemory> = vec![];

        let formatted = provider.format_memories(&memories);
        assert!(formatted.is_empty());
    }

    #[test]
    fn test_get_category_counts() {
        let memories = vec![
            create_test_memory(LongTermMemoryCategory::Semantic, "Fact 1"),
            create_test_memory(LongTermMemoryCategory::Semantic, "Fact 2"),
            create_test_memory(LongTermMemoryCategory::Episodic, "Event 1"),
        ];

        let counts = LongTermMemoryProvider::get_category_counts(&memories);

        assert!(counts.contains("semantic: 2") || counts.contains("Semantic: 2"));
        assert!(counts.contains("episodic: 1") || counts.contains("Episodic: 1"));
    }
}
