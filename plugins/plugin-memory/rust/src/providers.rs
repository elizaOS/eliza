#![allow(missing_docs)]

use serde_json::json;

use crate::error::Result;
use crate::types::*;

/// Provide memory context from stored long-term memories
pub fn get_memory_context(memories: &[serde_json::Value]) -> Result<ProviderResult> {
    let plugin_memories: Vec<&serde_json::Value> = memories
        .iter()
        .filter(|m| {
            m.get("source")
                .and_then(|s| s.as_str())
                .map(|s| s == memory_source())
                .unwrap_or(false)
        })
        .collect();

    if plugin_memories.is_empty() {
        return Ok(ProviderResult::new("No stored memories available"));
    }

    let mut parsed_entries: Vec<(ParsedMemory, String, i64)> = Vec::new();

    for mem in &plugin_memories {
        let text = mem.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let id = mem
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        let created_at = mem.get("createdAt").and_then(|c| c.as_i64()).unwrap_or(0);

        let parsed = decode_memory_text(text);
        parsed_entries.push((parsed, id, created_at));
    }

    // Sort by importance (desc) then recency (desc)
    parsed_entries.sort_by(|a, b| {
        let imp_cmp = (b.0.importance as u8).cmp(&(a.0.importance as u8));
        if imp_cmp != std::cmp::Ordering::Equal {
            return imp_cmp;
        }
        b.2.cmp(&a.2)
    });

    parsed_entries.truncate(20);

    let memory_list: Vec<String> = parsed_entries
        .iter()
        .map(|(parsed, _id, _created_at)| {
            let tag_str = if parsed.tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", parsed.tags.join(", "))
            };
            format!("- ({}) {}{}", parsed.importance, parsed.content, tag_str)
        })
        .collect();

    let count = parsed_entries.len();
    let text = format!("Stored Memories ({}):\n{}", count, memory_list.join("\n"));

    Ok(ProviderResult::with_data(
        text,
        json!({
            "memories": parsed_entries.iter().map(|(p, id, _)| json!({
                "id": id,
                "content": p.content,
                "tags": p.tags,
                "importance": p.importance as u8,
            })).collect::<Vec<_>>(),
            "count": count,
        }),
    ))
}
