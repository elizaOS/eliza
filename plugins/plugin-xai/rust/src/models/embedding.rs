//! Text embedding model handler using Grok.

use tracing::{debug, info};

use crate::grok::{EmbeddingParams, GrokClient};

/// Result of text embedding.
#[derive(Debug, Clone)]
pub struct EmbeddingResult {
    /// Whether embedding succeeded.
    pub success: bool,
    /// The embedding vector.
    pub embedding: Vec<f32>,
    /// Error message if failed.
    pub error: Option<String>,
}

/// Handler for TEXT_EMBEDDING model using grok-embedding.
pub struct TextEmbeddingHandler;

impl TextEmbeddingHandler {
    /// Model type identifier.
    pub const MODEL_TYPE: &'static str = "TEXT_EMBEDDING";

    /// Model name in Grok API.
    pub const MODEL_NAME: &'static str = "grok-embedding";

    /// Handle text embedding generation.
    ///
    /// # Arguments
    ///
    /// * `client` - The Grok client.
    /// * `text` - The text to embed.
    ///
    /// # Returns
    ///
    /// The embedding result.
    pub async fn handle(client: &GrokClient, text: &str) -> EmbeddingResult {
        info!(
            "TEXT_EMBEDDING: Creating embedding for text length {}",
            text.len()
        );

        let params = EmbeddingParams::new(text);
        match client.create_embedding(&params).await {
            Ok(embedding) => {
                debug!(
                    "TEXT_EMBEDDING: Created embedding with {} dimensions",
                    embedding.len()
                );
                EmbeddingResult {
                    success: true,
                    embedding,
                    error: None,
                }
            }
            Err(e) => EmbeddingResult {
                success: false,
                embedding: vec![],
                error: Some(e.to_string()),
            },
        }
    }

    /// Handle batch text embedding generation.
    ///
    /// # Arguments
    ///
    /// * `client` - The Grok client.
    /// * `texts` - The texts to embed.
    ///
    /// # Returns
    ///
    /// Vector of embedding results.
    pub async fn handle_batch(client: &GrokClient, texts: &[String]) -> Vec<EmbeddingResult> {
        let mut results = Vec::with_capacity(texts.len());

        for text in texts {
            results.push(Self::handle(client, text).await);
        }

        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedding_metadata() {
        assert_eq!(TextEmbeddingHandler::MODEL_TYPE, "TEXT_EMBEDDING");
        assert_eq!(TextEmbeddingHandler::MODEL_NAME, "grok-embedding");
    }
}
