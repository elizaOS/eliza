#![allow(missing_docs)]
//! Type definitions for the Scratchpad Plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A scratchpad file entry with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScratchpadEntry {
    /// Unique identifier (filename without extension)
    pub id: String,
    /// Full path to the scratchpad file
    pub path: String,
    /// Title/name of the scratchpad entry
    pub title: String,
    /// Content of the scratchpad entry
    pub content: String,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last modified timestamp
    pub modified_at: DateTime<Utc>,
    /// Tags for categorization
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A search result from the scratchpad.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScratchpadSearchResult {
    /// Path to the file
    pub path: String,
    /// Starting line number of the match
    pub start_line: usize,
    /// Ending line number of the match
    pub end_line: usize,
    /// Relevance score (0.0–1.0)
    pub score: f64,
    /// The matching snippet
    pub snippet: String,
    /// Entry ID (filename without extension)
    pub entry_id: String,
}

/// Options for reading a scratchpad entry.
#[derive(Debug, Clone, Default)]
pub struct ScratchpadReadOptions {
    /// Starting line number (1-indexed)
    pub from: Option<usize>,
    /// Number of lines to read
    pub lines: Option<usize>,
}

/// Options for writing a scratchpad entry.
#[derive(Debug, Clone, Default)]
pub struct ScratchpadWriteOptions {
    /// Tags to associate with the entry
    pub tags: Option<Vec<String>>,
    /// Whether to append to existing content
    pub append: bool,
}

/// Options for searching scratchpad entries.
#[derive(Debug, Clone)]
pub struct ScratchpadSearchOptions {
    /// Maximum number of results to return
    pub max_results: usize,
    /// Minimum relevance score (0.0–1.0)
    pub min_score: f64,
}

impl Default for ScratchpadSearchOptions {
    fn default() -> Self {
        Self {
            max_results: 10,
            min_score: 0.1,
        }
    }
}
