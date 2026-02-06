#![allow(missing_docs)]

use serde_json::{json, Value};

use crate::error::{MemoryError, Result};
use crate::types::*;

/// Handle the REMEMBER action - store a new memory entry
pub async fn remember(params: Value) -> Result<ActionResult> {
    let content = params
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or_else(|| MemoryError::InvalidInput("Content is required".to_string()))?;

    let tags: Vec<String> = params
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let importance_val = params
        .get("importance")
        .and_then(|i| i.as_u64())
        .map(|i| i as u8)
        .unwrap_or(2);

    let importance =
        MemoryImportance::try_from(importance_val).unwrap_or(MemoryImportance::Normal);

    let encoded = encode_memory_text(content, &tags, importance);

    let tag_str = if tags.is_empty() {
        String::new()
    } else {
        format!(" [tags: {}]", tags.join(", "))
    };

    Ok(ActionResult::success_with_data(
        format!("Remembered: \"{}\"{}",content, tag_str),
        json!({
            "content": content,
            "tags": tags,
            "importance": importance_val,
            "encoded": encoded,
        }),
    ))
}

/// Handle the RECALL action - search and retrieve stored memories
pub async fn recall(params: Value) -> Result<ActionResult> {
    let query = params
        .get("query")
        .and_then(|q| q.as_str())
        .ok_or_else(|| MemoryError::InvalidInput("Query is required".to_string()))?;

    let filter_tags: Vec<String> = params
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let limit = params
        .get("limit")
        .and_then(|l| l.as_u64())
        .map(|l| l as usize)
        .unwrap_or(10);

    let min_importance = params
        .get("minImportance")
        .and_then(|m| m.as_u64())
        .map(|m| m as u8)
        .and_then(|m| MemoryImportance::try_from(m).ok())
        .unwrap_or(MemoryImportance::Low);

    // Memories are passed in from the runtime layer
    let memories: Vec<Value> = params
        .get("memories")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();

    if memories.is_empty() {
        return Ok(ActionResult::success_with_data(
            "No stored memories found.",
            json!({ "memories": [], "count": 0 }),
        ));
    }

    let query_lower = query.to_lowercase();
    let query_words: Vec<&str> = query_lower.split_whitespace().collect();

    let mut scored_results: Vec<(f64, MemorySearchResult)> = Vec::new();

    for mem in &memories {
        let text = mem.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let source = mem.get("source").and_then(|s| s.as_str()).unwrap_or("");

        if source != memory_source() {
            continue;
        }

        let parsed = decode_memory_text(text);

        if (parsed.importance as u8) < (min_importance as u8) {
            continue;
        }

        if !filter_tags.is_empty() && !filter_tags.iter().any(|t| parsed.tags.contains(t)) {
            continue;
        }

        let content_lower = parsed.content.to_lowercase();
        let tags_str = parsed.tags.join(" ").to_lowercase();
        let mut score: f64 = 0.0;

        if content_lower.contains(&query_lower) {
            score += 10.0;
        }

        for word in &query_words {
            if word.len() < 2 {
                continue;
            }
            if content_lower.contains(word) {
                score += 2.0;
            }
            if tags_str.contains(word) {
                score += 3.0;
            }
        }

        score += parsed.importance as u8 as f64;

        if score > 0.0 {
            let id = mem
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            let created_at = mem
                .get("createdAt")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();

            scored_results.push((
                score,
                MemorySearchResult {
                    id,
                    content: parsed.content,
                    tags: parsed.tags,
                    importance: parsed.importance,
                    created_at,
                    score,
                },
            ));
        }
    }

    scored_results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored_results.truncate(limit);

    let results: Vec<MemorySearchResult> = scored_results.into_iter().map(|(_, r)| r).collect();

    if results.is_empty() {
        return Ok(ActionResult::success_with_data(
            "No memories found matching your query.",
            json!({ "memories": [], "count": 0 }),
        ));
    }

    let memory_list: Vec<String> = results
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let tag_str = if m.tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", m.tags.join(", "))
            };
            format!("{}. {}{}", i + 1, m.content, tag_str)
        })
        .collect();

    let count = results.len();
    let text = format!(
        "Found {} memor{}:\n\n{}",
        count,
        if count == 1 { "y" } else { "ies" },
        memory_list.join("\n")
    );

    Ok(ActionResult::success_with_data(
        text,
        json!({
            "memories": results,
            "count": count,
        }),
    ))
}

/// Handle the FORGET action - remove a stored memory
pub async fn forget(params: Value) -> Result<ActionResult> {
    let memory_id = params.get("memoryId").and_then(|m| m.as_str());
    let content_match = params.get("content").and_then(|c| c.as_str());

    if let Some(id) = memory_id {
        return Ok(ActionResult::success_with_data(
            format!("Removed memory with ID: {}", id),
            json!({ "removedId": id }),
        ));
    }

    if let Some(content) = content_match {
        return Ok(ActionResult::success_with_data(
            format!("Searching for memory matching: \"{}\"", content),
            json!({ "searchContent": content }),
        ));
    }

    Err(MemoryError::InvalidInput(
        "Either memoryId or content match is required".to_string(),
    ))
}
