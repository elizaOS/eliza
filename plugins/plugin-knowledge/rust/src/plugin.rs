#![allow(missing_docs)]

use crate::service::KnowledgeService;
use crate::types::{self, *};
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct KnowledgePlugin {
    service: Arc<RwLock<KnowledgeService>>,
    initialized: bool,
}

impl Default for KnowledgePlugin {
    fn default() -> Self {
        Self::new(KnowledgeConfig::default())
    }
}

impl KnowledgePlugin {
    pub const NAME: &'static str = "knowledge";
    pub const DESCRIPTION: &'static str = "Provides knowledge management and RAG capabilities";
    pub const VERSION: &'static str = crate::VERSION;

    pub fn new(config: KnowledgeConfig) -> Self {
        Self {
            service: Arc::new(RwLock::new(KnowledgeService::new(config))),
            initialized: false,
        }
    }

    pub fn service(&self) -> Arc<RwLock<KnowledgeService>> {
        Arc::clone(&self.service)
    }

    pub async fn init(&mut self) -> types::Result<()> {
        if self.initialized {
            return Ok(());
        }

        log::info!("Initializing Knowledge plugin...");

        let service = self.service.read().await;
        if service.config().load_docs_on_startup {
            drop(service);
            self.load_startup_documents().await?;
        }

        self.initialized = true;
        log::info!("Knowledge plugin initialized");

        Ok(())
    }

    async fn load_startup_documents(&self) -> types::Result<()> {
        use std::fs;
        use std::path::Path;

        let service = self.service.read().await;
        let knowledge_path = service.config().knowledge_path.clone();
        drop(service);

        let path = Path::new(&knowledge_path);

        if !path.exists() {
            log::debug!("Knowledge path '{}' does not exist", knowledge_path);
            return Ok(());
        }

        if !path.is_dir() {
            log::warn!("Knowledge path '{}' is not a directory", knowledge_path);
            return Ok(());
        }

        let extensions: &[(&str, &str)] = &[
            ("txt", "text/plain"),
            ("md", "text/markdown"),
            ("json", "application/json"),
        ];

        let entries = fs::read_dir(path)?;

        for entry in entries.flatten() {
            let file_path = entry.path();
            if !file_path.is_file() {
                continue;
            }

            let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");

            let content_type = extensions
                .iter()
                .find(|(e, _)| *e == ext)
                .map(|(_, ct)| *ct);

            if let Some(ct) = content_type {
                match fs::read_to_string(&file_path) {
                    Ok(content) => {
                        let filename = file_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string();

                        let options = AddKnowledgeOptions {
                            content,
                            content_type: ct.to_string(),
                            filename: filename.clone(),
                            ..Default::default()
                        };

                        let mut service = self.service.write().await;
                        match service.add_knowledge(options).await {
                            Ok(result) if result.success => {
                                log::info!(
                                    "Loaded '{}' with {} fragments",
                                    filename,
                                    result.fragment_count
                                );
                            }
                            Ok(result) => {
                                log::warn!("Failed to load '{}': {:?}", filename, result.error);
                            }
                            Err(e) => {
                                log::error!("Error loading '{}': {}", filename, e);
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("Error reading file {:?}: {}", file_path, e);
                    }
                }
            }
        }

        Ok(())
    }

    pub async fn add_knowledge(
        &self,
        options: AddKnowledgeOptions,
    ) -> types::Result<ProcessingResult> {
        let mut service = self.service.write().await;
        service.add_knowledge(options).await
    }

    pub async fn search(
        &self,
        query: &str,
        count: usize,
        threshold: f64,
    ) -> types::Result<Vec<SearchResult>> {
        let service = self.service.read().await;
        service.search(query, count, threshold).await
    }

    pub async fn get_knowledge(
        &self,
        query: &str,
        count: usize,
    ) -> types::Result<Vec<KnowledgeItem>> {
        let service = self.service.read().await;
        service.get_knowledge(query, count).await
    }

    pub async fn delete_knowledge(&self, document_id: &str) -> bool {
        let mut service = self.service.write().await;
        service.delete_knowledge(document_id).await
    }

    pub async fn get_documents(&self) -> Vec<KnowledgeDocument> {
        let service = self.service.read().await;
        service.get_documents().into_iter().cloned().collect()
    }

    pub async fn get_document(&self, document_id: &str) -> Option<KnowledgeDocument> {
        let service = self.service.read().await;
        service.get_document(document_id).cloned()
    }

    pub async fn get_context(&self, message: &str, count: usize) -> String {
        if message.trim().is_empty() {
            return String::new();
        }

        match self.get_knowledge(message, count).await {
            Ok(items) if !items.is_empty() => items
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    let similarity_pct = (item.similarity.unwrap_or(0.0) * 100.0) as i32;
                    format!(
                        "[Knowledge {}] (relevance: {}%)\n{}",
                        i + 1,
                        similarity_pct,
                        item.content
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n---\n\n"),
            _ => String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_new() {
        let plugin = KnowledgePlugin::default();
        assert_eq!(KnowledgePlugin::NAME, "knowledge");
        assert_eq!(KnowledgePlugin::VERSION, crate::VERSION);
        assert!(!plugin.initialized);
    }

    #[test]
    fn test_plugin_with_config() {
        let config = KnowledgeConfig {
            chunk_size: 200,
            ..Default::default()
        };
        let plugin = KnowledgePlugin::new(config);

        // Can't directly access config, but plugin should be created
        assert!(!plugin.initialized);
    }

    #[tokio::test]
    async fn test_plugin_init() {
        let mut plugin = KnowledgePlugin::default();
        plugin.init().await.unwrap();

        assert!(plugin.initialized);

        plugin.init().await.unwrap();
        assert!(plugin.initialized);
    }

    #[tokio::test]
    async fn test_plugin_add_knowledge() {
        let plugin = KnowledgePlugin::default();

        let options = AddKnowledgeOptions {
            content: "Test knowledge content. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "test.txt".to_string(),
            ..Default::default()
        };

        let result = plugin.add_knowledge(options).await.unwrap();

        assert!(result.success);
        assert!(!result.document_id.is_empty());
    }

    #[tokio::test]
    async fn test_plugin_delete_knowledge() {
        let plugin = KnowledgePlugin::default();

        let options = AddKnowledgeOptions {
            content: "Content to delete. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "delete.txt".to_string(),
            ..Default::default()
        };

        let result = plugin.add_knowledge(options).await.unwrap();
        let deleted = plugin.delete_knowledge(&result.document_id).await;

        assert!(deleted);
    }

    #[tokio::test]
    async fn test_plugin_get_documents() {
        let plugin = KnowledgePlugin::default();

        let options = AddKnowledgeOptions {
            content: "Document for listing. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "list-test.txt".to_string(),
            ..Default::default()
        };

        plugin.add_knowledge(options).await.unwrap();
        let documents = plugin.get_documents().await;

        assert!(!documents.is_empty());
    }

    #[tokio::test]
    async fn test_plugin_get_context_empty() {
        let plugin = KnowledgePlugin::default();

        let context = plugin.get_context("", 5).await;
        assert!(context.is_empty());

        let context2 = plugin.get_context("   ", 5).await;
        assert!(context2.is_empty());
    }

    #[test]
    fn test_create_knowledge_plugin() {
        let _plugin = KnowledgePlugin::default();
        assert_eq!(KnowledgePlugin::NAME, "knowledge");

        let config = KnowledgeConfig {
            chunk_size: 300,
            ..Default::default()
        };
        let plugin2 = KnowledgePlugin::new(config);
        assert!(!plugin2.initialized);
    }
}
