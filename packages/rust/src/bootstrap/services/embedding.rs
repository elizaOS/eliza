//! Embedding service implementation.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{PluginError, PluginResult};
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::ModelType;

use super::{Service, ServiceType};

/// Service for generating text embeddings.
pub struct EmbeddingService {
    runtime: Option<Arc<dyn IAgentRuntime>>,
    cache: HashMap<String, Vec<f32>>,
    cache_enabled: bool,
    max_cache_size: usize,
}

impl EmbeddingService {
    /// Create a new embedding service.
    pub fn new() -> Self {
        Self {
            runtime: None,
            cache: HashMap::new(),
            cache_enabled: true,
            max_cache_size: 1000,
        }
    }

    /// Generate an embedding for the given text.
    pub async fn embed(&mut self, text: &str) -> PluginResult<Vec<f32>> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| PluginError::ServiceNotStarted("embedding".to_string()))?;

        // Check cache first
        if self.cache_enabled {
            if let Some(cached) = self.cache.get(text) {
                return Ok(cached.clone());
            }
        }

        // Generate embedding
        let output = runtime
            .use_model(ModelType::TextEmbedding, ModelParams::with_text(text))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let embedding = output
            .as_embedding()
            .ok_or_else(|| PluginError::ModelError("Expected embedding output".to_string()))?
            .to_vec();

        // Cache result
        if self.cache_enabled {
            self.add_to_cache(text.to_string(), embedding.clone());
        }

        Ok(embedding)
    }

    /// Generate embeddings for multiple texts.
    pub async fn embed_batch(&mut self, texts: &[String]) -> PluginResult<Vec<Vec<f32>>> {
        let mut embeddings = Vec::with_capacity(texts.len());
        for text in texts {
            embeddings.push(self.embed(text).await?);
        }
        Ok(embeddings)
    }

    /// Calculate cosine similarity between two texts.
    pub async fn similarity(&mut self, text1: &str, text2: &str) -> PluginResult<f32> {
        let embedding1 = self.embed(text1).await?;
        let embedding2 = self.embed(text2).await?;

        let dot_product: f32 = embedding1
            .iter()
            .zip(embedding2.iter())
            .map(|(a, b)| a * b)
            .sum();

        let magnitude1: f32 = embedding1.iter().map(|a| a * a).sum::<f32>().sqrt();
        let magnitude2: f32 = embedding2.iter().map(|b| b * b).sum::<f32>().sqrt();

        if magnitude1 == 0.0 || magnitude2 == 0.0 {
            return Ok(0.0);
        }

        Ok(dot_product / (magnitude1 * magnitude2))
    }

    /// Clear the embedding cache.
    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }

    /// Enable or disable caching.
    pub fn set_cache_enabled(&mut self, enabled: bool) {
        self.cache_enabled = enabled;
        if !enabled {
            self.cache.clear();
        }
    }

    /// Set the maximum cache size.
    pub fn set_max_cache_size(&mut self, size: usize) {
        self.max_cache_size = size;
        self.trim_cache();
    }

    fn add_to_cache(&mut self, text: String, embedding: Vec<f32>) {
        if self.cache.len() >= self.max_cache_size {
            // Remove oldest entry (first key)
            if let Some(key) = self.cache.keys().next().cloned() {
                self.cache.remove(&key);
            }
        }
        self.cache.insert(text, embedding);
    }

    fn trim_cache(&mut self) {
        while self.cache.len() > self.max_cache_size {
            if let Some(key) = self.cache.keys().next().cloned() {
                self.cache.remove(&key);
            }
        }
    }
}

impl Default for EmbeddingService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for EmbeddingService {
    fn name(&self) -> &'static str {
        "embedding"
    }

    fn service_type(&self) -> ServiceType {
        ServiceType::Core
    }

    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("service:embedding", "Embedding service started");
        self.runtime = Some(runtime);
        Ok(())
    }

    async fn stop(&mut self) -> PluginResult<()> {
        if let Some(runtime) = &self.runtime {
            runtime.log_info("service:embedding", "Embedding service stopped");
        }
        self.cache.clear();
        self.runtime = None;
        Ok(())
    }
}
