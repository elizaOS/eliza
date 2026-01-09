//! Knowledge types for elizaOS
//!
//! Contains knowledge-related types for agent knowledge bases.

use serde::{Deserialize, Serialize};

/// Directory item for knowledge loading
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryItem {
    /// Directory path
    pub directory: String,
    /// Whether to recurse into subdirectories
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
    /// File extensions to include
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
}

/// Knowledge source - can be a file path, structured path, or directory
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KnowledgeSource {
    /// Simple file path
    Path(String),
    /// Path with metadata
    PathWithMeta {
        /// File path
        path: String,
        /// Whether knowledge is shared across agents
        #[serde(skip_serializing_if = "Option::is_none")]
        shared: Option<bool>,
    },
    /// Directory source
    Directory(DirectoryItem),
}

/// Knowledge chunk for embedding
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    /// Chunk text content
    pub content: String,
    /// Source file or URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Chunk index in document
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    /// Total chunks in document
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

/// Knowledge document
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    /// Document title
    pub title: String,
    /// Document content
    pub content: String,
    /// Source path or URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Document type (e.g., "markdown", "text", "pdf")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_type: Option<String>,
    /// Whether this is shared knowledge
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_knowledge_source_path() {
        let source = KnowledgeSource::Path("./docs/readme.md".to_string());
        let json = serde_json::to_string(&source).unwrap();
        assert_eq!(json, "\"./docs/readme.md\"");
    }

    #[test]
    fn test_knowledge_source_with_meta() {
        let source = KnowledgeSource::PathWithMeta {
            path: "./docs/readme.md".to_string(),
            shared: Some(true),
        };
        let json = serde_json::to_string(&source).unwrap();
        assert!(json.contains("\"path\":\"./docs/readme.md\""));
        assert!(json.contains("\"shared\":true"));
    }

    #[test]
    fn test_directory_item() {
        let dir = DirectoryItem {
            directory: "./knowledge".to_string(),
            recursive: Some(true),
            extensions: Some(vec!["md".to_string(), "txt".to_string()]),
        };
        let json = serde_json::to_string(&dir).unwrap();
        assert!(json.contains("\"directory\":\"./knowledge\""));
        assert!(json.contains("\"recursive\":true"));
    }
}
