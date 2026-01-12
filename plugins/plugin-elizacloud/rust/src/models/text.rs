#![allow(missing_docs)]

use crate::error::Result;
use crate::providers::ElizaCloudClient;
use crate::types::{ElizaCloudConfig, TextGenerationParams};

pub async fn handle_text_small(
    config: ElizaCloudConfig,
    params: TextGenerationParams,
) -> Result<String> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_text_small(params).await
}

pub async fn handle_text_large(
    config: ElizaCloudConfig,
    params: TextGenerationParams,
) -> Result<String> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_text_large(params).await
}
