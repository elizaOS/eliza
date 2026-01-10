//! Text generation model handlers.

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TextGenerationParams};

/// Handle TEXT_SMALL model generation.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Text generation parameters
///
/// # Returns
///
/// Generated text string.
pub async fn handle_text_small(
    config: ElizaCloudConfig,
    params: TextGenerationParams,
) -> Result<String> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_text_small(params).await
}

/// Handle TEXT_LARGE model generation.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Text generation parameters
///
/// # Returns
///
/// Generated text string.
pub async fn handle_text_large(
    config: ElizaCloudConfig,
    params: TextGenerationParams,
) -> Result<String> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_text_large(params).await
}

