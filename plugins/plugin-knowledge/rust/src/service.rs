#![allow(missing_docs)]
//! Knowledge Service - Core RAG functionality.

use crate::chunker::TextChunker;
use crate::types::{self, *};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

/// The Knowledge Service provides core RAG functionality.
///
/// Handles document processing, embedding generation, and semantic search.
pub struct KnowledgeService {
    config: KnowledgeConfig,
    chunker: TextChunker,
    documents: HashMap<String, KnowledgeDocument>,
    fragments: HashMap<String, KnowledgeFragment>,
}

impl KnowledgeService {
    /// Create a new knowledge service with the given configuration.
    pub fn new(config: KnowledgeConfig) -> Self {
        let chunker = TextChunker::new(config.chunk_size, config.chunk_overlap);

        Self {
            config,
            chunker,
            documents: HashMap::new(),
            fragments: HashMap::new(),
        }
    }

    /// Create a new knowledge service with default configuration.
    pub fn default() -> Self {
        Self::new(KnowledgeConfig::default())
    }

    /// Get the service configuration.
    pub fn config(&self) -> &KnowledgeConfig {
        &self.config
    }

    /// Generate a deterministic content ID based on content.
    pub fn generate_content_id(
        &self,
        content: &str,
        agent_id: &str,
        filename: Option<&str>,
    ) -> String {
        // Use first 2000 chars for ID generation
        let content_for_hash: String = content
            .chars()
            .take(2000)
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        // Create hash components
        let mut hash_input = format!("{}::{}", agent_id, content_for_hash);
        if let Some(fname) = filename {
            hash_input = format!("{}::{}", hash_input, fname);
        }

        // Generate SHA-256 hash
        let mut hasher = Sha256::new();
        hasher.update(hash_input.as_bytes());
        let hash = hex::encode(hasher.finalize());

        // Generate UUID v5 from hash
        let namespace = Uuid::NAMESPACE_DNS;
        let uuid = Uuid::new_v5(&namespace, hash.as_bytes());

        uuid.to_string()
    }

    /// Add knowledge to the system.
    pub async fn add_knowledge(&mut self, options: AddKnowledgeOptions) -> types::Result<ProcessingResult> {
        let agent_id = options.agent_id.as_deref().unwrap_or("default");

        // Generate content-based ID
        let document_id = self.generate_content_id(
            &options.content,
            agent_id,
            Some(&options.filename),
        );

        // Check if document already exists
        if let Some(existing) = self.documents.get(&document_id) {
            return Ok(ProcessingResult {
                document_id,
                fragment_count: existing.fragments.len(),
                success: true,
                error: None,
            });
        }

        // Extract text content
        let text_content = self.extract_text(&options.content, &options.content_type)?;

        if text_content.trim().is_empty() {
            return Ok(ProcessingResult {
                document_id,
                fragment_count: 0,
                success: false,
                error: Some("No text content extracted".to_string()),
            });
        }

        // Create document
        let mut document = KnowledgeDocument {
            id: document_id.clone(),
            content: text_content.clone(),
            filename: options.filename.clone(),
            content_type: options.content_type.clone(),
            file_size: options.content.len(),
            fragments: Vec::new(),
            metadata: options.metadata.clone(),
        };

        // Add memory type to metadata
        document.metadata.insert(
            "type".to_string(),
            serde_json::Value::String("document".to_string()),
        );

        // Split into chunks
        let chunk_result = self.chunker.split(&text_content);

        // Create fragments
        let mut fragments = Vec::new();
        for (i, chunk) in chunk_result.chunks.into_iter().enumerate() {
            let fragment_id = format!("{}-{}", document_id, i);

            let mut fragment_metadata = HashMap::new();
            fragment_metadata.insert(
                "type".to_string(),
                serde_json::Value::String("fragment".to_string()),
            );
            fragment_metadata.insert(
                "document_id".to_string(),
                serde_json::Value::String(document_id.clone()),
            );
            fragment_metadata.insert(
                "position".to_string(),
                serde_json::Value::Number(serde_json::Number::from(i as u64)),
            );

            let fragment = KnowledgeFragment {
                id: fragment_id.clone(),
                document_id: document_id.clone(),
                content: chunk,
                position: i,
                embedding: None,
                metadata: fragment_metadata,
            };

            self.fragments.insert(fragment_id.clone(), fragment.clone());
            fragments.push(fragment);
        }

        let fragment_count = fragments.len();
        document.fragments = fragments;
        self.documents.insert(document_id.clone(), document);

        log::info!(
            "Added document '{}' with {} fragments",
            options.filename,
            fragment_count
        );

        Ok(ProcessingResult {
            document_id,
            fragment_count,
            success: true,
            error: None,
        })
    }

    /// Extract text from content based on type.
    fn extract_text(&self, content: &str, content_type: &str) -> types::Result<String> {
        // For text types, content is already text
        if content_type.starts_with("text/")
            || content_type == "application/json"
            || content_type == "application/xml"
        {
            return Ok(content.to_string());
        }

        // For binary types, we'd need additional processing
        // For now, return as-is and log warning
        log::warn!("Unsupported content type for text extraction: {}", content_type);
        Ok(content.to_string())
    }

    /// Search for relevant knowledge.
    pub async fn search(
        &self,
        query: &str,
        count: usize,
        threshold: f64,
    ) -> types::Result<Vec<SearchResult>> {
        // Without embedding provider, we can't do semantic search
        // Return empty for now (in production, would use actual embeddings)
        log::debug!("Searching for: {} (count: {}, threshold: {})", query, count, threshold);

        // Simple text matching fallback when no embeddings
        let query_lower = query.to_lowercase();
        let mut results: Vec<SearchResult> = Vec::new();

        for fragment in self.fragments.values() {
            let content_lower = fragment.content.to_lowercase();

            // Simple relevance score based on word overlap
            let query_words: Vec<&str> = query_lower.split_whitespace().collect();
            let matching_words = query_words
                .iter()
                .filter(|w| content_lower.contains(*w))
                .count();

            if matching_words > 0 {
                let similarity = matching_words as f64 / query_words.len() as f64;

                if similarity >= threshold {
                    let document = self.documents.get(&fragment.document_id);

                    results.push(SearchResult {
                        id: fragment.id.clone(),
                        content: fragment.content.clone(),
                        similarity,
                        document_id: Some(fragment.document_id.clone()),
                        document_title: document.map(|d| d.filename.clone()),
                        metadata: fragment.metadata.clone(),
                    });
                }
            }
        }

        // Sort by similarity
        results.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));

        // Limit results
        results.truncate(count);

        Ok(results)
    }

    /// Get knowledge items relevant to a query.
    pub async fn get_knowledge(&self, query: &str, count: usize) -> types::Result<Vec<KnowledgeItem>> {
        let results: Vec<SearchResult> = self.search(query, count, 0.1).await?;

        Ok(results
            .into_iter()
            .map(|r| KnowledgeItem {
                id: r.id,
                content: r.content,
                similarity: Some(r.similarity),
                embedding: None,
                metadata: r.metadata,
            })
            .collect())
    }

    /// Delete a knowledge document and its fragments.
    pub async fn delete_knowledge(&mut self, document_id: &str) -> bool {
        if let Some(document) = self.documents.remove(document_id) {
            // Remove fragments
            for fragment in &document.fragments {
                self.fragments.remove(&fragment.id);
            }

            log::info!("Deleted document {}", document_id);
            true
        } else {
            false
        }
    }

    /// Get all documents in the knowledge base.
    pub fn get_documents(&self) -> Vec<&KnowledgeDocument> {
        self.documents.values().collect()
    }

    /// Get a document by ID.
    pub fn get_document(&self, document_id: &str) -> Option<&KnowledgeDocument> {
        self.documents.get(document_id)
    }

    /// Calculate cosine similarity between two vectors.
    pub fn cosine_similarity(vec1: &[f32], vec2: &[f32]) -> f64 {
        if vec1.len() != vec2.len() {
            return 0.0;
        }

        let dot_product: f64 = vec1
            .iter()
            .zip(vec2.iter())
            .map(|(a, b)| (*a as f64) * (*b as f64))
            .sum();

        let norm1: f64 = vec1.iter().map(|a| (*a as f64).powi(2)).sum::<f64>().sqrt();
        let norm2: f64 = vec2.iter().map(|b| (*b as f64).powi(2)).sum::<f64>().sqrt();

        if norm1 == 0.0 || norm2 == 0.0 {
            return 0.0;
        }

        dot_product / (norm1 * norm2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_new() {
        let config = KnowledgeConfig::default();
        let service = KnowledgeService::new(config);

        assert_eq!(service.config().chunk_size, 500);
        assert!(service.documents.is_empty());
    }

    #[test]
    fn test_generate_content_id_deterministic() {
        let service = KnowledgeService::default();

        let id1 = service.generate_content_id("Test content", "agent-1", Some("test.txt"));
        let id2 = service.generate_content_id("Test content", "agent-1", Some("test.txt"));

        assert_eq!(id1, id2);
    }

    #[test]
    fn test_generate_content_id_different_content() {
        let service = KnowledgeService::default();

        let id1 = service.generate_content_id("Content A", "agent-1", Some("test.txt"));
        let id2 = service.generate_content_id("Content B", "agent-1", Some("test.txt"));

        assert_ne!(id1, id2);
    }

    #[tokio::test]
    async fn test_add_knowledge() {
        let mut service = KnowledgeService::default();

        let options = AddKnowledgeOptions {
            content: "This is test content for the knowledge base. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "test.txt".to_string(),
            agent_id: Some("test-agent".to_string()),
            ..Default::default()
        };

        let result = service.add_knowledge(options).await.unwrap();

        assert!(result.success);
        assert!(!result.document_id.is_empty());
        assert!(result.fragment_count > 0);
    }

    #[tokio::test]
    async fn test_add_knowledge_duplicate() {
        let mut service = KnowledgeService::default();

        let options = AddKnowledgeOptions {
            content: "Duplicate content test. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "test.txt".to_string(),
            agent_id: Some("test-agent".to_string()),
            ..Default::default()
        };

        let result1 = service.add_knowledge(options.clone()).await.unwrap();
        let result2 = service.add_knowledge(options).await.unwrap();

        assert_eq!(result1.document_id, result2.document_id);
        assert_eq!(result1.fragment_count, result2.fragment_count);
    }

    #[tokio::test]
    async fn test_delete_knowledge() {
        let mut service = KnowledgeService::default();

        let options = AddKnowledgeOptions {
            content: "Content to be deleted. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "delete-test.txt".to_string(),
            agent_id: Some("test-agent".to_string()),
            ..Default::default()
        };

        let result = service.add_knowledge(options).await.unwrap();
        assert!(result.success);

        let deleted = service.delete_knowledge(&result.document_id).await;
        assert!(deleted);

        // Try to delete again
        let deleted_again = service.delete_knowledge(&result.document_id).await;
        assert!(!deleted_again);
    }

    #[tokio::test]
    async fn test_get_documents() {
        let mut service = KnowledgeService::default();

        let options = AddKnowledgeOptions {
            content: "Document content for listing. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "list-test.txt".to_string(),
            agent_id: Some("test-agent".to_string()),
            ..Default::default()
        };

        service.add_knowledge(options).await.unwrap();
        let documents = service.get_documents();

        assert!(!documents.is_empty());
        assert!(documents.iter().any(|d| d.filename == "list-test.txt"));
    }

    #[test]
    fn test_cosine_similarity_same() {
        let vec1 = vec![1.0, 0.0, 0.0];
        let vec2 = vec![1.0, 0.0, 0.0];

        let sim = KnowledgeService::cosine_similarity(&vec1, &vec2);
        assert!((sim - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let vec1 = vec![1.0, 0.0, 0.0];
        let vec2 = vec![0.0, 1.0, 0.0];

        let sim = KnowledgeService::cosine_similarity(&vec1, &vec2);
        assert!(sim.abs() < 0.001);
    }

    #[test]
    fn test_cosine_similarity_opposite() {
        let vec1 = vec![1.0, 0.0, 0.0];
        let vec2 = vec![-1.0, 0.0, 0.0];

        let sim = KnowledgeService::cosine_similarity(&vec1, &vec2);
        assert!((sim + 1.0).abs() < 0.001);
    }
}





