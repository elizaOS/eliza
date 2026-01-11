//! elizaOS Knowledge Plugin
//!
//! Provides Retrieval Augmented Generation (RAG) capabilities including:
//! - Document processing and text extraction
//! - Text chunking with semantic awareness
//! - Embedding generation via multiple providers
//! - Semantic search and knowledge retrieval

mod types;
mod service;
mod plugin;
mod chunker;

pub use types::*;
pub use service::KnowledgeService;
pub use plugin::KnowledgePlugin;
pub use chunker::TextChunker;

/// Plugin version
pub const VERSION: &str = "1.6.1";

/// Plugin name
pub const PLUGIN_NAME: &str = "knowledge";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert_eq!(VERSION, "1.6.1");
    }

    #[test]
    fn test_plugin_name() {
        assert_eq!(PLUGIN_NAME, "knowledge");
    }
}



