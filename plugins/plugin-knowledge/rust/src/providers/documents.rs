use async_trait::async_trait;
use log::error;

use super::{KnowledgeProviderTrait, ProviderContext, ProviderResult};
use crate::types::KnowledgeDocument;

pub struct DocumentsProvider {
    documents: Vec<KnowledgeDocument>,
}

impl DocumentsProvider {
    pub fn new() -> Self {
        Self {
            documents: Vec::new(),
        }
    }

    pub fn update_documents(&mut self, documents: Vec<KnowledgeDocument>) {
        self.documents = documents;
    }

    pub fn format_documents(&self, documents: &[&KnowledgeDocument]) -> String {
        if documents.is_empty() {
            return String::new();
        }

        documents
            .iter()
            .map(|doc| {
                let mut parts = vec![doc.filename.clone()];

                if !doc.content_type.is_empty() && doc.content_type != "unknown" {
                    parts.push(doc.content_type.clone());
                }

                if doc.file_size > 0 {
                    let size_kb = doc.file_size / 1024;
                    if size_kb >= 1024 {
                        parts.push(format!("{}MB", size_kb / 1024));
                    } else {
                        parts.push(format!("{}KB", size_kb));
                    }
                }

                if let Some(source) = doc.metadata.get("source") {
                    if let Some(source_str) = source.as_str() {
                        if source_str != "upload" {
                            parts.push(format!("from {}", source_str));
                        }
                    }
                }

                parts.join(" - ")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn add_header(header: &str, content: &str) -> String {
        if content.is_empty() {
            String::new()
        } else {
            format!("{}\n\n{}", header, content)
        }
    }
}

impl Default for DocumentsProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl KnowledgeProviderTrait for DocumentsProvider {
    fn name(&self) -> &'static str {
        "AVAILABLE_DOCUMENTS"
    }

    fn description(&self) -> &'static str {
        "List of documents available in the knowledge base. Shows which documents the agent can reference and retrieve information from."
    }

    fn dynamic(&self) -> bool {
        false
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let documents_value = context.state.get("documents");

        let documents: Vec<KnowledgeDocument> = documents_value
            .and_then(|v| {
                serde_json::from_value(v.clone())
                    .map_err(|e| {
                        error!("Failed to deserialize documents: {}", e);
                        e
                    })
                    .ok()
            })
            .unwrap_or_else(|| self.documents.clone());

        if documents.is_empty() {
            return ProviderResult {
                data: serde_json::json!({ "documents": [] }),
                values: serde_json::json!({
                    "documentsCount": 0,
                    "documents": "",
                    "availableDocuments": "",
                }),
                text: String::new(),
            };
        }

        let doc_refs: Vec<&KnowledgeDocument> = documents.iter().collect();
        let documents_list = self.format_documents(&doc_refs);
        let documents_text = Self::add_header(
            "# Available Documents",
            &format!(
                "{} document(s) in knowledge base:\n{}",
                documents.len(),
                documents_list
            ),
        );

        let documents_data: Vec<serde_json::Value> = documents
            .iter()
            .map(|doc| {
                serde_json::json!({
                    "id": doc.id,
                    "filename": doc.filename,
                    "contentType": doc.content_type,
                    "fileSize": doc.file_size,
                    "source": doc.metadata.get("source"),
                })
            })
            .collect();

        ProviderResult {
            data: serde_json::json!({
                "documents": documents_data,
                "count": documents.len(),
            }),
            values: serde_json::json!({
                "documentsCount": documents.len(),
                "documents": documents_list,
                "availableDocuments": documents_text,
            }),
            text: documents_text,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn create_test_document(filename: &str, size: usize) -> KnowledgeDocument {
        KnowledgeDocument {
            id: format!("doc-{}", filename),
            content: "Test content".to_string(),
            filename: filename.to_string(),
            content_type: "text/plain".to_string(),
            file_size: size,
            fragments: Vec::new(),
            metadata: HashMap::new(),
        }
    }

    #[test]
    fn test_format_documents() {
        let provider = DocumentsProvider::new();

        let doc1 = create_test_document("readme.md", 2048);
        let doc2 = create_test_document("guide.pdf", 1024 * 1024);

        let docs: Vec<&KnowledgeDocument> = vec![&doc1, &doc2];
        let formatted = provider.format_documents(&docs);

        assert!(formatted.contains("readme.md"));
        assert!(formatted.contains("text/plain"));
        assert!(formatted.contains("2KB"));

        assert!(formatted.contains("guide.pdf"));
        assert!(formatted.contains("1MB"));
    }

    #[test]
    fn test_format_documents_empty() {
        let provider = DocumentsProvider::new();
        let docs: Vec<&KnowledgeDocument> = vec![];
        let formatted = provider.format_documents(&docs);
        assert!(formatted.is_empty());
    }

    #[tokio::test]
    async fn test_get_empty() {
        let provider = DocumentsProvider::new();
        let context = ProviderContext {
            agent_id: uuid::Uuid::new_v4(),
            entity_id: None,
            room_id: None,
            query: None,
            state: serde_json::json!({}),
        };

        let result = provider.get(&context).await;

        assert_eq!(result.data["documents"], serde_json::json!([]));
        assert!(result.text.is_empty());
    }
}
