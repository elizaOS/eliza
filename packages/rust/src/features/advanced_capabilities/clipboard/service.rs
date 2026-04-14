//! ClipboardService — manages clipboard entries and task clipboard.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::types::*;

/// In-memory clipboard service.
pub struct ClipboardService {
    /// File-based clipboard entries.
    entries: Arc<RwLock<HashMap<String, ClipboardEntry>>>,
    /// Task clipboard items per task/room ID.
    task_clipboards: Arc<RwLock<HashMap<String, Vec<TaskClipboardItem>>>>,
}

impl ClipboardService {
    /// Create a new empty ClipboardService.
    pub fn new() -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
            task_clipboards: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Write a clipboard entry.
    pub async fn write(
        &self,
        title: &str,
        content: &str,
        options: &ClipboardWriteOptions,
    ) -> anyhow::Result<ClipboardEntry> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();

        let entry = ClipboardEntry {
            id: id.clone(),
            path: format!("clipboard/{}.md", id),
            title: title.to_string(),
            content: content.to_string(),
            created_at: now,
            modified_at: now,
            tags: options.tags.clone(),
        };

        self.entries.write().await.insert(id, entry.clone());
        Ok(entry)
    }

    /// Read a clipboard entry by ID.
    pub async fn read(
        &self,
        id: &str,
        options: &ClipboardReadOptions,
    ) -> anyhow::Result<Option<String>> {
        let entries = self.entries.read().await;
        let entry = match entries.get(id) {
            Some(e) => e,
            None => return Ok(None),
        };

        let lines: Vec<&str> = entry.content.lines().collect();
        let from = options.from.unwrap_or(1).saturating_sub(1);
        let count = options.lines.unwrap_or(lines.len());

        let selected: Vec<&str> = lines.into_iter().skip(from).take(count).collect();
        Ok(Some(selected.join("\n")))
    }

    /// Delete a clipboard entry.
    pub async fn delete(&self, id: &str) -> anyhow::Result<bool> {
        Ok(self.entries.write().await.remove(id).is_some())
    }

    /// List all clipboard entries.
    pub async fn list(&self) -> Vec<ClipboardEntry> {
        self.entries.read().await.values().cloned().collect()
    }

    /// Search clipboard entries by text.
    pub async fn search(
        &self,
        query: &str,
        options: &ClipboardSearchOptions,
    ) -> Vec<ClipboardSearchResult> {
        let entries = self.entries.read().await;
        let query_lower = query.to_lowercase();
        let max_results = options.max_results.unwrap_or(10);
        let min_score = options.min_score.unwrap_or(0.0);

        let mut results: Vec<ClipboardSearchResult> = entries
            .values()
            .filter_map(|entry| {
                let content_lower = entry.content.to_lowercase();
                let title_lower = entry.title.to_lowercase();

                let score = if title_lower.contains(&query_lower) {
                    0.9
                } else if content_lower.contains(&query_lower) {
                    0.6
                } else {
                    return None;
                };

                if score < min_score {
                    return None;
                }

                // Find the matching line
                let lines: Vec<&str> = entry.content.lines().collect();
                let start_line = lines
                    .iter()
                    .position(|l| l.to_lowercase().contains(&query_lower))
                    .unwrap_or(0);

                let snippet = lines
                    .get(start_line)
                    .map(|s| s.to_string())
                    .unwrap_or_default();

                Some(ClipboardSearchResult {
                    path: entry.path.clone(),
                    start_line: start_line + 1,
                    end_line: start_line + 1,
                    score,
                    snippet,
                    entry_id: entry.id.clone(),
                })
            })
            .collect();

        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(max_results);
        results
    }

    // ========================================================================
    // Task clipboard
    // ========================================================================

    /// Add an item to a task clipboard.
    pub async fn add_task_item(
        &self,
        task_id: &str,
        input: AddTaskClipboardItemInput,
    ) -> anyhow::Result<TaskClipboardItem> {
        let now = chrono::Utc::now().to_rfc3339();
        let item = TaskClipboardItem {
            id: Uuid::new_v4().to_string(),
            title: input
                .title
                .unwrap_or_else(|| "Clipboard item".to_string()),
            content: input.content,
            source_type: input
                .source_type
                .unwrap_or(TaskClipboardSourceType::Manual),
            source_id: input.source_id,
            source_label: input.source_label,
            mime_type: input.mime_type,
            created_at: now.clone(),
            updated_at: now,
        };

        let mut clipboards = self.task_clipboards.write().await;
        let items = clipboards
            .entry(task_id.to_string())
            .or_insert_with(Vec::new);

        items.push(item.clone());

        // Enforce max items
        while items.len() > TASK_CLIPBOARD_MAX_ITEMS {
            items.remove(0);
        }

        Ok(item)
    }

    /// Get task clipboard snapshot.
    pub async fn get_task_clipboard(&self, task_id: &str) -> TaskClipboardSnapshot {
        let clipboards = self.task_clipboards.read().await;
        let items = clipboards
            .get(task_id)
            .cloned()
            .unwrap_or_default();

        TaskClipboardSnapshot {
            max_items: TASK_CLIPBOARD_MAX_ITEMS,
            items,
        }
    }

    /// Remove a task clipboard item.
    pub async fn remove_task_item(&self, task_id: &str, item_id: &str) -> bool {
        let mut clipboards = self.task_clipboards.write().await;
        if let Some(items) = clipboards.get_mut(task_id) {
            let before = items.len();
            items.retain(|i| i.id != item_id);
            items.len() < before
        } else {
            false
        }
    }
}

impl Default for ClipboardService {
    fn default() -> Self {
        Self::new()
    }
}
