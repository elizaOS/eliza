#![allow(missing_docs)]

use crate::chunker::TextChunker;
use crate::types::{self, *};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct KnowledgeService {
    config: KnowledgeConfig,
    chunker: TextChunker,
    documents: HashMap<String, KnowledgeDocument>,
    fragments: HashMap<String, KnowledgeFragment>,
    /// SHA-256 content hash → document_id for deduplication
    content_hashes: HashMap<String, String>,
    /// Pending RAG enrichment entries
    pending_rag_enrichment: Vec<PendingRAGEntry>,
}

impl Default for KnowledgeService {
    fn default() -> Self {
        Self::new(KnowledgeConfig::default())
    }
}

impl KnowledgeService {
    pub fn new(config: KnowledgeConfig) -> Self {
        let chunker = TextChunker::new(config.chunk_size, config.chunk_overlap);

        Self {
            config,
            chunker,
            documents: HashMap::new(),
            fragments: HashMap::new(),
            content_hashes: HashMap::new(),
            pending_rag_enrichment: Vec::new(),
        }
    }

    pub fn config(&self) -> &KnowledgeConfig {
        &self.config
    }

    // ------------------------------------------------------------------
    // Content-based deduplication (SHA-256 + UUID v5)
    // ------------------------------------------------------------------

    pub fn generate_content_id(
        &self,
        content: &str,
        agent_id: &str,
        filename: Option<&str>,
    ) -> String {
        let content_for_hash: String = content
            .chars()
            .take(2000)
            .collect::<String>()
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .trim()
            .to_string();

        let mut hash_input = format!("{}::{}", agent_id, content_for_hash);
        if let Some(fname) = filename {
            if !fname.is_empty() {
                hash_input = format!("{}::{}", hash_input, fname);
            }
        }

        let mut hasher = Sha256::new();
        hasher.update(hash_input.as_bytes());
        let hash = hex::encode(hasher.finalize());

        // Use the same namespace UUID as TypeScript (DNS namespace)
        let namespace =
            Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap_or(Uuid::NAMESPACE_DNS);
        let uuid = Uuid::new_v5(&namespace, hash.as_bytes());

        uuid.to_string()
    }

    /// Compute a SHA-256 hex digest for fast deduplication lookups.
    pub fn compute_content_hash(&self, content: &str) -> String {
        let normalized: String = content
            .chars()
            .take(4000)
            .collect::<String>()
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .trim()
            .to_string();

        let mut hasher = Sha256::new();
        hasher.update(normalized.as_bytes());
        hex::encode(hasher.finalize())
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    // ------------------------------------------------------------------
    // Add knowledge (main entry point)
    // ------------------------------------------------------------------

    pub async fn add_knowledge(
        &mut self,
        options: AddKnowledgeOptions,
    ) -> types::Result<ProcessingResult> {
        let agent_id = options.agent_id.as_deref().unwrap_or("default");

        let document_id =
            self.generate_content_id(&options.content, agent_id, Some(&options.filename));

        // Check duplicate by content hash
        let content_hash = self.compute_content_hash(&options.content);
        if let Some(existing_doc_id) = self.content_hashes.get(&content_hash) {
            if let Some(existing) = self.documents.get(existing_doc_id) {
                log::info!(
                    "\"{}\" already exists (hash match) - skipping",
                    options.filename
                );
                return Ok(ProcessingResult {
                    document_id: existing_doc_id.clone(),
                    fragment_count: existing.fragments.len(),
                    success: true,
                    error: None,
                });
            }
        }

        // Check duplicate by ID
        if let Some(existing) = self.documents.get(&document_id) {
            log::info!(
                "\"{}\" already exists (ID match) - skipping",
                options.filename
            );
            return Ok(ProcessingResult {
                document_id,
                fragment_count: existing.fragments.len(),
                success: true,
                error: None,
            });
        }

        let text_content = self.extract_text(&options.content, &options.content_type, &options.filename)?;

        if text_content.trim().is_empty() {
            return Ok(ProcessingResult {
                document_id,
                fragment_count: 0,
                success: false,
                error: Some("No text content extracted".to_string()),
            });
        }

        // Build document metadata
        let file_ext = options
            .filename
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let title = if file_ext.is_empty() {
            options.filename.clone()
        } else {
            options.filename.replace(&format!(".{}", file_ext), "")
        };

        let mut doc_metadata = options.metadata.clone();
        doc_metadata.insert(
            "type".to_string(),
            serde_json::Value::String("document".to_string()),
        );
        doc_metadata.insert(
            "source".to_string(),
            serde_json::Value::String("knowledge-service".to_string()),
        );
        doc_metadata.insert(
            "title".to_string(),
            serde_json::Value::String(title),
        );
        doc_metadata.insert(
            "filename".to_string(),
            serde_json::Value::String(options.filename.clone()),
        );
        doc_metadata.insert(
            "fileExt".to_string(),
            serde_json::Value::String(file_ext),
        );
        doc_metadata.insert(
            "fileType".to_string(),
            serde_json::Value::String(options.content_type.clone()),
        );
        doc_metadata.insert(
            "fileSize".to_string(),
            serde_json::Value::Number(serde_json::Number::from(options.content.len() as u64)),
        );
        doc_metadata.insert(
            "timestamp".to_string(),
            serde_json::Value::Number(serde_json::Number::from(Self::now_millis())),
        );

        let mut document = KnowledgeDocument {
            id: document_id.clone(),
            content: text_content.clone(),
            filename: options.filename.clone(),
            content_type: options.content_type.clone(),
            file_size: options.content.len(),
            content_hash: content_hash.clone(),
            fragments: Vec::new(),
            metadata: doc_metadata,
        };

        let chunk_result = self.chunker.split(&text_content);

        let mut fragments = Vec::new();
        let now = Self::now_millis();
        for (i, chunk) in chunk_result.chunks.into_iter().enumerate() {
            let fragment_id = format!("{}-fragment-{}-{}", document_id, i, now);

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
            fragment_metadata.insert(
                "timestamp".to_string(),
                serde_json::Value::Number(serde_json::Number::from(now)),
            );
            fragment_metadata.insert(
                "source".to_string(),
                serde_json::Value::String("rag-service-fragment-sync".to_string()),
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
        self.content_hashes
            .insert(content_hash, document_id.clone());

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

    // ------------------------------------------------------------------
    // Text extraction (PDF, plain text)
    // ------------------------------------------------------------------

    fn extract_text(
        &self,
        content: &str,
        content_type: &str,
        filename: &str,
    ) -> types::Result<String> {
        // Text content types
        if content_type.starts_with("text/")
            || content_type == "application/json"
            || content_type == "application/xml"
        {
            // Check for base64-encoded text
            if Self::looks_like_base64(content) {
                if let Ok(decoded) = base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    content,
                ) {
                    if let Ok(text) = String::from_utf8(decoded) {
                        return Ok(text);
                    }
                }
            }
            return Ok(content.to_string());
        }

        // PDF extraction
        if content_type == "application/pdf" || filename.to_lowercase().ends_with(".pdf") {
            return self.extract_pdf_text(content, filename);
        }

        // Fallback: try as text
        if Self::looks_like_base64(content) {
            if let Ok(decoded) = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                content,
            ) {
                if let Ok(text) = String::from_utf8(decoded) {
                    return Ok(text);
                }
            }
        }

        Ok(content.to_string())
    }

    fn extract_pdf_text(&self, content: &str, filename: &str) -> types::Result<String> {
        let pdf_bytes = if Self::looks_like_base64(content) {
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, content)
                .map_err(|e| {
                    KnowledgeError::PdfError(format!(
                        "Failed to decode base64 for {}: {}",
                        filename, e
                    ))
                })?
        } else {
            content.as_bytes().to_vec()
        };

        // Use pdf-extract crate
        match pdf_extract::extract_text_from_mem(&pdf_bytes) {
            Ok(text) => {
                let cleaned = Self::clean_pdf_text(&text);
                if cleaned.trim().is_empty() {
                    Err(KnowledgeError::PdfError(format!(
                        "No text extracted from PDF: {}",
                        filename
                    )))
                } else {
                    Ok(cleaned)
                }
            }
            Err(e) => Err(KnowledgeError::PdfError(format!(
                "Failed to extract text from PDF {}: {}",
                filename, e
            ))),
        }
    }

    fn clean_pdf_text(text: &str) -> String {
        let cleaned: Vec<&str> = text
            .split('\n')
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let mut result = cleaned.join("\n");
        // Collapse triple+ newlines
        while result.contains("\n\n\n") {
            result = result.replace("\n\n\n", "\n\n");
        }
        result
    }

    fn looks_like_base64(content: &str) -> bool {
        if content.len() < 16 {
            return false;
        }
        let clean: String = content.chars().filter(|c| !c.is_whitespace()).collect();
        if clean.len() % 4 != 0 {
            return false;
        }
        clean
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
    }

    // ------------------------------------------------------------------
    // Search with cosine similarity (replaces word-matching)
    // ------------------------------------------------------------------

    pub async fn search(
        &self,
        query: &str,
        count: usize,
        threshold: f64,
    ) -> types::Result<Vec<SearchResult>> {
        log::debug!(
            "Searching for: {} (count: {}, threshold: {})",
            query,
            count,
            threshold
        );

        // If any fragments have embeddings, use cosine similarity search
        let has_embeddings = self.fragments.values().any(|f| f.embedding.is_some());

        if has_embeddings {
            // NOTE: In production, the caller provides the query embedding via
            // an external embedding provider. For in-process usage without an
            // embedding provider, fall back to keyword search.
            return self.search_with_keywords(query, count, threshold);
        }

        // Fallback: keyword-based search
        self.search_with_keywords(query, count, threshold)
    }

    /// Search using precomputed query embedding against fragment embeddings.
    pub fn search_with_embedding(
        &self,
        query_embedding: &[f32],
        count: usize,
        threshold: f64,
    ) -> Vec<SearchResult> {
        let mut results: Vec<SearchResult> = Vec::new();

        for fragment in self.fragments.values() {
            if let Some(ref embedding) = fragment.embedding {
                let similarity = Self::cosine_similarity(query_embedding, embedding);

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

        results.sort_by(|a, b| {
            b.similarity
                .partial_cmp(&a.similarity)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(count);

        results
    }

    fn search_with_keywords(
        &self,
        query: &str,
        count: usize,
        threshold: f64,
    ) -> types::Result<Vec<SearchResult>> {
        let query_lower = query.to_lowercase();
        let query_words: Vec<&str> = query_lower.split_whitespace().collect();
        let mut results: Vec<SearchResult> = Vec::new();

        if query_words.is_empty() {
            return Ok(results);
        }

        for fragment in self.fragments.values() {
            let content_lower = fragment.content.to_lowercase();

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

        results.sort_by(|a, b| {
            b.similarity
                .partial_cmp(&a.similarity)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(count);

        Ok(results)
    }

    pub async fn get_knowledge(
        &self,
        query: &str,
        count: usize,
    ) -> types::Result<Vec<KnowledgeItem>> {
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

    // ------------------------------------------------------------------
    // RAG enrichment (mirrors TypeScript)
    // ------------------------------------------------------------------

    /// Build RAG metadata from knowledge items.
    pub fn build_rag_metadata(&self, items: &[KnowledgeItem], query_text: &str) -> RAGMetadata {
        RAGMetadata {
            retrieved_fragments: items
                .iter()
                .map(|item| {
                    let doc_title = item
                        .metadata
                        .get("filename")
                        .and_then(|v| v.as_str())
                        .or_else(|| item.metadata.get("title").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string();

                    let preview = if item.content.len() > 100 {
                        format!("{}...", &item.content[..100])
                    } else {
                        item.content.clone()
                    };

                    RetrievedFragmentInfo {
                        fragment_id: item.id.clone(),
                        document_title: doc_title,
                        similarity_score: item.similarity,
                        content_preview: preview,
                    }
                })
                .collect(),
            query_text: query_text.to_string(),
            total_fragments: items.len(),
            retrieval_timestamp: Self::now_millis(),
            used_in_response: true,
        }
    }

    /// Queue RAG metadata for later enrichment of conversation memories.
    pub fn set_pending_rag_metadata(&mut self, rag_metadata: RAGMetadata) {
        let now = Self::now_millis();
        // Prune stale entries (older than 30 seconds)
        self.pending_rag_enrichment
            .retain(|e| now - e.timestamp < 30000);
        self.pending_rag_enrichment.push(PendingRAGEntry {
            rag_metadata,
            timestamp: now,
        });
    }

    /// Get pending RAG enrichment entries (for external memory store integration).
    pub fn pending_rag_entries(&self) -> &[PendingRAGEntry] {
        &self.pending_rag_enrichment
    }

    /// Clear a specific pending RAG entry after enrichment.
    pub fn clear_pending_rag_entry(&mut self, index: usize) {
        if index < self.pending_rag_enrichment.len() {
            self.pending_rag_enrichment.remove(index);
        }
    }

    // ------------------------------------------------------------------
    // Set embeddings on fragments (called by external embedding provider)
    // ------------------------------------------------------------------

    /// Set embedding on a specific fragment. Called after external embedding generation.
    pub fn set_fragment_embedding(&mut self, fragment_id: &str, embedding: Vec<f32>) -> bool {
        if let Some(fragment) = self.fragments.get_mut(fragment_id) {
            fragment.embedding = Some(embedding.clone());
            // Also update in document's fragment list
            if let Some(doc) = self.documents.get_mut(&fragment.document_id) {
                for doc_frag in &mut doc.fragments {
                    if doc_frag.id == fragment_id {
                        doc_frag.embedding = Some(embedding);
                        break;
                    }
                }
            }
            true
        } else {
            false
        }
    }

    // ------------------------------------------------------------------
    // Cosine similarity
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // CRUD helpers
    // ------------------------------------------------------------------

    pub async fn check_existing_knowledge(&self, knowledge_id: &str) -> bool {
        self.documents.contains_key(knowledge_id)
    }

    pub async fn delete_knowledge(&mut self, document_id: &str) -> bool {
        if let Some(document) = self.documents.remove(document_id) {
            for fragment in &document.fragments {
                self.fragments.remove(&fragment.id);
            }

            // Remove content hash mapping
            if !document.content_hash.is_empty() {
                self.content_hashes.remove(&document.content_hash);
            }

            log::info!("Deleted document {}", document_id);
            true
        } else {
            false
        }
    }

    pub fn get_documents(&self) -> Vec<&KnowledgeDocument> {
        self.documents.values().collect()
    }

    pub fn get_document(&self, document_id: &str) -> Option<&KnowledgeDocument> {
        self.documents.get(document_id)
    }

    pub fn get_fragment_count(&self) -> usize {
        self.fragments.len()
    }

    /// Get all fragment IDs for a document (useful for batch embedding).
    pub fn get_fragment_ids_for_document(&self, document_id: &str) -> Vec<String> {
        self.documents
            .get(document_id)
            .map(|doc| doc.fragments.iter().map(|f| f.id.clone()).collect())
            .unwrap_or_default()
    }

    /// Get fragment text by ID.
    pub fn get_fragment_text(&self, fragment_id: &str) -> Option<&str> {
        self.fragments.get(fragment_id).map(|f| f.content.as_str())
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

    #[test]
    fn test_generate_content_id_different_agents() {
        let service = KnowledgeService::default();
        let id1 = service.generate_content_id("Content", "agent-1", None);
        let id2 = service.generate_content_id("Content", "agent-2", None);
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_compute_content_hash() {
        let service = KnowledgeService::default();
        let h1 = service.compute_content_hash("Hello world");
        let h2 = service.compute_content_hash("Hello world");
        let h3 = service.compute_content_hash("Different");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
    }

    #[test]
    fn test_compute_content_hash_line_normalization() {
        let service = KnowledgeService::default();
        let h1 = service.compute_content_hash("line1\r\nline2");
        let h2 = service.compute_content_hash("line1\nline2");
        assert_eq!(h1, h2);
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
    async fn test_add_knowledge_duplicate_by_id() {
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
    async fn test_add_knowledge_duplicate_by_hash() {
        let mut service = KnowledgeService::default();
        let content = "Same content for hash test. ".repeat(20);

        let r1 = service
            .add_knowledge(AddKnowledgeOptions {
                content: content.clone(),
                content_type: "text/plain".to_string(),
                filename: "a.txt".to_string(),
                agent_id: Some("agent".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(r1.success);

        let r2 = service
            .add_knowledge(AddKnowledgeOptions {
                content,
                content_type: "text/plain".to_string(),
                filename: "b.txt".to_string(),
                agent_id: Some("agent".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(r2.success);
        // Hash dedup should catch it
    }

    #[tokio::test]
    async fn test_add_knowledge_empty_content() {
        let mut service = KnowledgeService::default();
        let options = AddKnowledgeOptions {
            content: "   ".to_string(),
            content_type: "text/plain".to_string(),
            filename: "empty.txt".to_string(),
            ..Default::default()
        };
        let result = service.add_knowledge(options).await.unwrap();
        assert!(!result.success);
        assert!(result.error.is_some());
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

        let deleted_again = service.delete_knowledge(&result.document_id).await;
        assert!(!deleted_again);
    }

    #[tokio::test]
    async fn test_delete_clears_hash() {
        let mut service = KnowledgeService::default();
        let content = "Hash clearing test content. ".repeat(20);
        let options = AddKnowledgeOptions {
            content: content.clone(),
            content_type: "text/plain".to_string(),
            filename: "hash.txt".to_string(),
            ..Default::default()
        };
        let result = service.add_knowledge(options).await.unwrap();
        assert!(!service.content_hashes.is_empty());

        service.delete_knowledge(&result.document_id).await;

        let hash = service.compute_content_hash(&content);
        assert!(!service.content_hashes.contains_key(&hash));
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

    #[tokio::test]
    async fn test_document_metadata() {
        let mut service = KnowledgeService::default();
        let options = AddKnowledgeOptions {
            content: "Metadata test content. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "meta.txt".to_string(),
            ..Default::default()
        };
        let result = service.add_knowledge(options).await.unwrap();
        let doc = service.get_document(&result.document_id).unwrap();

        assert_eq!(doc.metadata["type"], "document");
        assert_eq!(doc.metadata["source"], "knowledge-service");
        assert_eq!(doc.metadata["title"], "meta");
        assert_eq!(doc.metadata["filename"], "meta.txt");
    }

    #[tokio::test]
    async fn test_fragment_metadata() {
        let mut service = KnowledgeService::default();
        let options = AddKnowledgeOptions {
            content: "Fragment metadata test content. ".repeat(30),
            content_type: "text/plain".to_string(),
            filename: "frag-meta.txt".to_string(),
            ..Default::default()
        };
        let result = service.add_knowledge(options).await.unwrap();
        let doc = service.get_document(&result.document_id).unwrap();

        for (i, frag) in doc.fragments.iter().enumerate() {
            assert_eq!(frag.metadata["type"], "fragment");
            assert_eq!(frag.metadata["document_id"], result.document_id);
            assert_eq!(frag.metadata["position"], i as u64);
        }
    }

    // ------------------------------------------------------------------
    // Cosine similarity tests
    // ------------------------------------------------------------------

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

    #[test]
    fn test_cosine_similarity_zero_vector() {
        let vec1 = vec![1.0, 2.0, 3.0];
        let vec2 = vec![0.0, 0.0, 0.0];
        assert_eq!(KnowledgeService::cosine_similarity(&vec1, &vec2), 0.0);
    }

    #[test]
    fn test_cosine_similarity_different_lengths() {
        let vec1 = vec![1.0, 2.0];
        let vec2 = vec![1.0, 2.0, 3.0];
        assert_eq!(KnowledgeService::cosine_similarity(&vec1, &vec2), 0.0);
    }

    // ------------------------------------------------------------------
    // Embedding-based search tests
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn test_search_with_embedding() {
        let mut service = KnowledgeService::default();

        // Add a document
        let options = AddKnowledgeOptions {
            content: "Machine learning and artificial intelligence. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "ai.txt".to_string(),
            ..Default::default()
        };
        let result = service.add_knowledge(options).await.unwrap();

        // Set embeddings on fragments
        let frag_ids = service.get_fragment_ids_for_document(&result.document_id);
        for frag_id in &frag_ids {
            service.set_fragment_embedding(frag_id, vec![0.8, 0.2, 0.1, 0.0]);
        }

        // Search with a similar embedding
        let query_embedding = vec![0.7, 0.3, 0.1, 0.0];
        let results = service.search_with_embedding(&query_embedding, 5, 0.1);

        assert!(!results.is_empty());
        assert!(results[0].similarity > 0.9);
    }

    #[test]
    fn test_set_fragment_embedding() {
        let mut service = KnowledgeService::default();

        // Manually add a fragment
        let frag = KnowledgeFragment {
            id: "frag-1".to_string(),
            document_id: "doc-1".to_string(),
            content: "Test".to_string(),
            position: 0,
            embedding: None,
            metadata: HashMap::new(),
        };
        service.fragments.insert("frag-1".to_string(), frag);

        assert!(service.set_fragment_embedding("frag-1", vec![0.1, 0.2, 0.3]));
        assert!(!service.set_fragment_embedding("nonexistent", vec![0.1]));

        let stored = service.fragments.get("frag-1").unwrap();
        assert!(stored.embedding.is_some());
        assert_eq!(stored.embedding.as_ref().unwrap().len(), 3);
    }

    // ------------------------------------------------------------------
    // RAG metadata tests
    // ------------------------------------------------------------------

    #[test]
    fn test_build_rag_metadata() {
        let service = KnowledgeService::default();
        let items = vec![
            KnowledgeItem {
                id: "frag-1".to_string(),
                content: "AI content".to_string(),
                similarity: Some(0.95),
                embedding: None,
                metadata: {
                    let mut m = HashMap::new();
                    m.insert(
                        "filename".to_string(),
                        serde_json::Value::String("ai.txt".to_string()),
                    );
                    m
                },
            },
            KnowledgeItem {
                id: "frag-2".to_string(),
                content: "ML content that is longer than one hundred characters to test the truncation behavior in the content preview field properly".to_string(),
                similarity: Some(0.85),
                embedding: None,
                metadata: HashMap::new(),
            },
        ];

        let rag = service.build_rag_metadata(&items, "AI query");
        assert_eq!(rag.retrieved_fragments.len(), 2);
        assert_eq!(rag.query_text, "AI query");
        assert_eq!(rag.total_fragments, 2);
        assert!(rag.retrieval_timestamp > 0);
        assert_eq!(rag.retrieved_fragments[0].fragment_id, "frag-1");
        assert_eq!(rag.retrieved_fragments[0].document_title, "ai.txt");
        assert!(rag.retrieved_fragments[1].content_preview.ends_with("..."));
    }

    #[test]
    fn test_set_pending_rag_metadata() {
        let mut service = KnowledgeService::default();
        let rag = RAGMetadata::default();
        service.set_pending_rag_metadata(rag);
        assert_eq!(service.pending_rag_entries().len(), 1);
    }

    #[test]
    fn test_pending_rag_prunes_stale() {
        let mut service = KnowledgeService::default();
        // Add a stale entry
        service.pending_rag_enrichment.push(PendingRAGEntry {
            rag_metadata: RAGMetadata::default(),
            timestamp: 0, // Very old
        });

        service.set_pending_rag_metadata(RAGMetadata::default());
        // Stale entry should have been pruned
        assert_eq!(service.pending_rag_entries().len(), 1);
    }

    // ------------------------------------------------------------------
    // Utility tests
    // ------------------------------------------------------------------

    #[test]
    fn test_looks_like_base64() {
        assert!(KnowledgeService::looks_like_base64("SGVsbG8gV29ybGQ="));
        assert!(!KnowledgeService::looks_like_base64("Hello World"));
        assert!(!KnowledgeService::looks_like_base64("short"));
    }

    #[tokio::test]
    async fn test_get_fragment_count() {
        let mut service = KnowledgeService::default();
        assert_eq!(service.get_fragment_count(), 0);

        service
            .add_knowledge(AddKnowledgeOptions {
                content: "Fragment count test. ".repeat(30),
                content_type: "text/plain".to_string(),
                filename: "count.txt".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(service.get_fragment_count() > 0);
    }

    #[tokio::test]
    async fn test_check_existing_knowledge() {
        let mut service = KnowledgeService::default();
        let result = service
            .add_knowledge(AddKnowledgeOptions {
                content: "Existence check test. ".repeat(20),
                content_type: "text/plain".to_string(),
                filename: "exist.txt".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(service.check_existing_knowledge(&result.document_id).await);
        assert!(!service.check_existing_knowledge("nonexistent").await);
    }
}
