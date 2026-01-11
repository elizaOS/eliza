#![allow(missing_docs)]
//! Text embedding model handlers.

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TextEmbeddingParams};

/// Handle TEXT_EMBEDDING model for a single text.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `text` - Text to embed
///
/// # Returns
///
/// Embedding vector as Vec<f32>.
pub async fn handle_text_embedding(
    config: ElizaCloudConfig,
    text: String,
) -> Result<Vec<f32>> {
    let client = ElizaCloudClient::new(config)?;
    let params = TextEmbeddingParams::single(text);
    let embeddings = client.generate_embedding(params).await?;
    Ok(embeddings.into_iter().next().unwrap_or_default())
}

/// Handle batch TEXT_EMBEDDING for multiple texts.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `texts` - List of texts to embed
///
/// # Returns
///
/// List of embedding vectors.
pub async fn handle_batch_text_embedding(
    config: ElizaCloudConfig,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let client = ElizaCloudClient::new(config)?;
    let params = TextEmbeddingParams::batch(texts);
    client.generate_embedding(params).await
}







