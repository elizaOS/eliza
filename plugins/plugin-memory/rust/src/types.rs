#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

/// Importance levels for stored memories
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryImportance {
    Low = 1,
    Normal = 2,
    High = 3,
    Critical = 4,
}

impl std::fmt::Display for MemoryImportance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoryImportance::Low => write!(f, "low"),
            MemoryImportance::Normal => write!(f, "normal"),
            MemoryImportance::High => write!(f, "high"),
            MemoryImportance::Critical => write!(f, "critical"),
        }
    }
}

impl Default for MemoryImportance {
    fn default() -> Self {
        Self::Normal
    }
}

impl TryFrom<u8> for MemoryImportance {
    type Error = String;

    fn try_from(value: u8) -> std::result::Result<Self, Self::Error> {
        match value {
            1 => Ok(MemoryImportance::Low),
            2 => Ok(MemoryImportance::Normal),
            3 => Ok(MemoryImportance::High),
            4 => Ok(MemoryImportance::Critical),
            _ => Err(format!("Invalid importance level: {}", value)),
        }
    }
}

/// Parameters for the REMEMBER action
#[derive(Debug, Clone, Default)]
pub struct RememberInput {
    pub content: String,
    pub tags: Vec<String>,
    pub importance: MemoryImportance,
    pub metadata: serde_json::Value,
}

/// Parameters for the RECALL action
#[derive(Debug, Clone, Default)]
pub struct RecallInput {
    pub query: String,
    pub tags: Vec<String>,
    pub limit: Option<usize>,
    pub min_importance: Option<MemoryImportance>,
}

/// Parameters for the FORGET action
#[derive(Debug, Clone)]
pub struct ForgetInput {
    pub memory_id: Option<String>,
    pub content_match: Option<String>,
}

/// Result from a memory search with relevance score
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySearchResult {
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub importance: MemoryImportance,
    pub created_at: String,
    pub score: f64,
}

/// Internal metadata stored alongside memory content
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncodedMetadata {
    #[serde(rename = "t")]
    tags: Vec<String>,
    #[serde(rename = "i")]
    importance: u8,
}

/// Parsed memory data after decoding from storage
#[derive(Debug, Clone)]
pub struct ParsedMemory {
    pub content: String,
    pub tags: Vec<String>,
    pub importance: MemoryImportance,
}

/// Separator between metadata and content in stored memory text
pub const MEMORY_SEPARATOR: &str = "\n---\n";

/// Source identifier for memories created by this plugin
pub const MEMORY_SOURCE: &str = "plugin-memory";

/// Encode memory content with metadata into a storable text format.
pub fn encode_memory_text(content: &str, tags: &[String], importance: MemoryImportance) -> String {
    let metadata = EncodedMetadata {
        tags: tags.to_vec(),
        importance: importance as u8,
    };
    let metadata_str = serde_json::to_string(&metadata).unwrap_or_default();
    format!("{}{}{}", metadata_str, MEMORY_SEPARATOR, content)
}

/// Decode a stored memory text into its content and metadata.
pub fn decode_memory_text(text: &str) -> ParsedMemory {
    if let Some(sep_pos) = text.find(MEMORY_SEPARATOR) {
        let metadata_str = &text[..sep_pos];
        let content = &text[sep_pos + MEMORY_SEPARATOR.len()..];

        if let Ok(metadata) = serde_json::from_str::<EncodedMetadata>(metadata_str) {
            return ParsedMemory {
                content: content.to_string(),
                tags: metadata.tags,
                importance: MemoryImportance::try_from(metadata.importance)
                    .unwrap_or(MemoryImportance::Normal),
            };
        }
    }

    ParsedMemory {
        content: text.to_string(),
        tags: Vec::new(),
        importance: MemoryImportance::Normal,
    }
}

/// Get the memory source identifier
pub fn memory_source() -> &'static str {
    MEMORY_SOURCE
}

/// Result from an action handler
#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub text: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ActionResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: None,
        }
    }

    pub fn success_with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: Some(data),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: false,
            data: None,
        }
    }
}

/// Result from a provider
#[derive(Debug, Clone, Serialize)]
pub struct ProviderResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ProviderResult {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            data: None,
        }
    }

    pub fn with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            data: Some(data),
        }
    }
}
