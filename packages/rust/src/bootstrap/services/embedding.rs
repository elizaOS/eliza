//! Embedding service implementation.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::error::{PluginError, PluginResult};
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::events::{EmbeddingGenerationPayload, EventPayload, EventType};
use crate::types::memory::MemoryMetadata;
use crate::types::ModelType;

use super::{Service, ServiceType};

#[cfg(test)]
mod mock_adapter;

/// Service for generating text embeddings.
pub struct EmbeddingService {
    runtime: Option<Arc<dyn IAgentRuntime>>,
    cache: HashMap<String, Vec<f32>>,
    cache_enabled: bool,
    max_cache_size: usize,
    sender: mpsc::UnboundedSender<EmbeddingGenerationPayload>,
    receiver: Option<mpsc::UnboundedReceiver<EmbeddingGenerationPayload>>,
}

impl EmbeddingService {
    /// Create a new embedding service.
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            runtime: None,
            cache: HashMap::new(),
            cache_enabled: true,
            max_cache_size: 1000,
            sender,
            receiver: Some(receiver),
        }
    }

    /// Max characters for embedding input (~8K tokens at ~4 chars/token).
    const MAX_EMBEDDING_CHARS: usize = 32_000;

    /// Generate an embedding for the given text.
    pub async fn embed(&mut self, text: &str) -> PluginResult<Vec<f32>> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| PluginError::ServiceNotStarted("embedding".to_string()))?;

        // Truncate to stay within embedding model token limits
        let embed_text: &str = if text.len() > Self::MAX_EMBEDDING_CHARS {
            runtime.log_warning(
                "service:embedding",
                &format!(
                    "Truncating embedding input from {} to {} chars",
                    text.len(),
                    Self::MAX_EMBEDDING_CHARS
                ),
            );
            &text[..Self::MAX_EMBEDDING_CHARS]
        } else {
            text
        };

        // Check cache first (use original text as key for consistency)
        if self.cache_enabled {
            if let Some(cached) = self.cache.get(text) {
                return Ok(cached.clone());
            }
        }

        // Generate embedding
        let output = runtime
            .use_model(ModelType::TextEmbedding, ModelParams::with_text(embed_text))
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
        self.runtime = Some(runtime.clone());

        let sender = self.sender.clone();
        runtime
            .register_event(
                EventType::EmbeddingGenerationRequested,
                Arc::new(move |payload| {
                    let sender = sender.clone();
                    if let Ok(data) = serde_json::from_value::<EmbeddingGenerationPayload>(
                        serde_json::to_value(payload).unwrap(),
                    ) {
                        if let Err(e) = sender.send(data) {
                            error!("Failed to send embedding request to queue: {}", e);
                        }
                    }
                    Ok(())
                }),
            )
            .await;

        if let Some(mut receiver) = self.receiver.take() {
            let runtime_clone = runtime.clone();
            tokio::spawn(async move {
                info!("Embedding generation worker started");
                while let Some(mut payload) = receiver.recv().await {
                    let memory = &mut payload.memory;
                    let memory_id = match memory.id {
                        Some(ref id) => id.clone(),
                        None => {
                            warn!("Skipping embedding generation for memory without ID");
                            continue;
                        }
                    };

                    // Skip if already has embedding
                    if memory.embedding.is_some() {
                        continue;
                    }

                    let text = match memory.content.text.as_ref() {
                        Some(t) if !t.is_empty() => t.clone(),
                        _ => {
                            warn!("Skipping embedding generation for memory without text");
                            continue;
                        }
                    };

                    // Generate intent if needed
                    let mut embedding_source_text = text.clone();
                    if text.len() > 20 {
                        // Check if intent already exists
                        let has_intent = memory.metadata.as_ref().map_or(false, |m| {
                            let MemoryMetadata::Custom(v) = m;
                            v.get("intent").is_some()
                        });

                        if !has_intent {
                            let prompt = format!(
                                "Analyze the following message and extract the core user intent or a summary of what they are asking/saying. Return ONLY the intent text.\nMessage:\n\"{}\"\n\nIntent:",
                                text
                            );

                            match runtime_clone
                                .use_model(
                                    ModelType::TextSmall,
                                    ModelParams {
                                        prompt: Some(prompt),
                                        ..Default::default()
                                    },
                                )
                                .await
                            {
                                Ok(output) => {
                                    if let Some(intent) = output.as_text() {
                                        let intent = intent.trim().to_string();
                                        if !intent.is_empty() {
                                            embedding_source_text = intent.clone();

                                            // Update metadata with intent
                                            let mut metadata_value = match &memory.metadata {
                                                Some(MemoryMetadata::Custom(v)) => v.clone(),
                                                None => serde_json::json!({}),
                                            };
                                            if let Some(obj) = metadata_value.as_object_mut() {
                                                obj.insert(
                                                    "intent".to_string(),
                                                    serde_json::Value::String(intent),
                                                );
                                            }
                                            memory.metadata =
                                                Some(MemoryMetadata::Custom(metadata_value));
                                        }
                                    }
                                }
                                Err(e) => {
                                    warn!("Failed to generate intent: {}", e);
                                }
                            }
                        }
                    }

                    // Generate embedding using helper (need to extract method or use logic directly)
                    // We can't use self.embed because self is not available here.
                    // We must use runtime directly.

                    // Truncate
                    let embed_text = if embedding_source_text.len() > 32_000 {
                        &embedding_source_text[..32_000]
                    } else {
                        &embedding_source_text
                    };

                    match runtime_clone
                        .use_model(ModelType::TextEmbedding, ModelParams::with_text(embed_text))
                        .await
                    {
                        Ok(output) => {
                            if let Some(embedding_vec) = output.as_embedding() {
                                let embedding = embedding_vec.to_vec();
                                memory.embedding = Some(embedding.clone());

                                // Update memory in DB
                                if let Some(adapter) = runtime_clone.get_adapter() {
                                    if let Err(e) = adapter.update_memory(memory).await {
                                        error!("Failed to update memory with embedding: {}", e);
                                    } else {
                                        debug!(
                                            "Generated and saved embedding for memory {:?}",
                                            memory_id
                                        );
                                        // Emit completion event
                                        let _ = runtime_clone
                                            .emit_event(
                                                EventType::EmbeddingGenerationCompleted,
                                                EventPayload {
                                                    source: "embedding_service".to_string(),
                                                    extra: HashMap::new(),
                                                },
                                            )
                                            .await;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            error!("Failed to generate embedding: {}", e);
                        }
                    }
                }
            });
        }

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

#[cfg(test)]
mod tests {
    use super::mock_adapter::MockDatabaseAdapter;
    use super::*;
    use crate::runtime::ModelOutput;
    use crate::runtime::{AgentRuntime, RuntimeOptions};
    use crate::types::memory::Memory;
    use crate::types::primitives::UUID;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn test_async_embedding_generation() {
        let adapter = Arc::new(MockDatabaseAdapter::default());
        let runtime = AgentRuntime::new(RuntimeOptions {
            adapter: Some(adapter.clone()),
            ..Default::default()
        })
        .await
        .unwrap();

        // Register mock embedding model
        runtime
            .register_model(
                "TEXT_EMBEDDING",
                Box::new(|params| {
                    Box::pin(async move {
                        // params is serde_json::Value
                        let _len = params
                            .get("text")
                            .and_then(|v| v.as_str())
                            .map(|s| s.len())
                            .unwrap_or(0);
                        let embedding = vec![0.1; 384]; // 384 dim
                                                        // Native runtime expects JSON string
                        let output = serde_json::json!(embedding).to_string();
                        Ok(output)
                    })
                }),
            )
            .await;

        // Register mock small text model (for intent)
        runtime
            .register_model(
                "TEXT_SMALL",
                Box::new(|_params| Box::pin(async move { Ok("intent".to_string()) })),
            )
            .await;

        let mut service = EmbeddingService::new();
        service.start(runtime.clone()).await.unwrap();

        // Setup completion listener
        let completed = Arc::new(AtomicBool::new(false));
        let completed_clone = completed.clone();
        runtime
            .register_event(
                EventType::EmbeddingGenerationCompleted,
                Arc::new(move |_| {
                    completed_clone.store(true, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await;

        // Create memory
        let mut memory = Memory::message(
            UUID::new_v4(),
            UUID::new_v4(),
            "A very long message that should trigger intent generation and then embedding.",
        );

        // Save memory first (as service expects it in DB/adapter usually, but here we just pass it in event)
        let adapter = runtime.get_adapter().unwrap();
        // Ensure ID is set
        if memory.id.is_none() {
            memory.id = Some(UUID::new_v4());
        }
        let memory_id = memory.id.clone().unwrap();

        adapter.create_memory(&memory, "messages").await.unwrap();

        // Emit request
        let mut extra = HashMap::new();
        extra.insert("memory".to_string(), serde_json::to_value(&memory).unwrap());

        runtime
            .emit_event(
                EventType::EmbeddingGenerationRequested,
                EventPayload {
                    source: "test".to_string(),
                    extra,
                },
            )
            .await;

        // Wait for completion
        let start = std::time::Instant::now();
        let mut success = false;
        while start.elapsed() < Duration::from_secs(5) {
            if completed.load(Ordering::SeqCst) {
                success = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        assert!(
            success,
            "Embedding generation did not complete within timeout"
        );

        // Verify intent was generated and embedding saved
        if let Some(saved_opt) = adapter.get_memory_by_id(&memory_id).await.unwrap() {
            assert!(
                saved_opt.embedding.is_some(),
                "Memory should have embedding"
            );

            if let Some(MemoryMetadata::Custom(meta)) = saved_opt.metadata {
                if let Some(intent_val) = meta.get("intent") {
                    assert_eq!(intent_val.as_str().unwrap(), "intent");
                } else {
                    panic!("Intent missing in metadata: {:?}", meta);
                }
            } else {
                panic!("Memory metadata should be present");
            }
        } else {
            panic!("Memory not found in DB");
        }
    }
}
