#![allow(missing_docs)]

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TextEmbeddingParams};

pub async fn handle_text_embedding(config: ElizaCloudConfig, text: String) -> Result<Vec<f32>> {
    let client = ElizaCloudClient::new(config)?;
    let params = TextEmbeddingParams::single(text);
    let embeddings = client.generate_embedding(params).await?;
    Ok(embeddings.into_iter().next().unwrap_or_default())
}

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
