//! Clipboard types — Rust port of the TypeScript clipboard types.

use serde::{Deserialize, Serialize};

/// A clipboard entry stored as a file-based memory.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    /// Unique identifier (filename without extension).
    pub id: String,
    /// Full path to the clipboard file.
    pub path: String,
    /// Title/name of the clipboard entry.
    pub title: String,
    /// Content of the clipboard entry.
    pub content: String,
    /// Creation timestamp (millis).
    pub created_at: i64,
    /// Last modified timestamp (millis).
    pub modified_at: i64,
    /// Optional tags for categorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Search result from clipboard.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSearchResult {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    /// Relevance score (0-1).
    pub score: f64,
    pub snippet: String,
    pub entry_id: String,
}

/// Options for reading clipboard content.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardReadOptions {
    /// Starting line number (1-indexed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<usize>,
    /// Number of lines to read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<usize>,
}

/// Options for writing clipboard content.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWriteOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub append: bool,
}

/// Options for searching clipboard.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSearchOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_score: Option<f64>,
}

/// Clipboard configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardConfig {
    pub base_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_file_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_extensions: Option<Vec<String>>,
}

/// Maximum items in the task clipboard.
pub const TASK_CLIPBOARD_MAX_ITEMS: usize = 5;

/// Source type for task clipboard items.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskClipboardSourceType {
    Manual,
    Command,
    File,
    Attachment,
    ImageAttachment,
    Channel,
    ConversationSearch,
    Entity,
    EntitySearch,
}

/// A single task clipboard item.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskClipboardItem {
    /// Stable clipboard item ID exposed to the agent context.
    pub id: String,
    /// Short label for the item.
    pub title: String,
    /// Stored working-memory content.
    pub content: String,
    /// Where the item came from.
    pub source_type: TaskClipboardSourceType,
    /// Original file path or attachment ID when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Human-readable locator such as a file path or attachment name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    /// Optional MIME type when sourced from an attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Snapshot of the task clipboard state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskClipboardSnapshot {
    pub max_items: usize,
    pub items: Vec<TaskClipboardItem>,
}

/// Input for adding a task clipboard item.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTaskClipboardItemInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_type: Option<TaskClipboardSourceType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}
