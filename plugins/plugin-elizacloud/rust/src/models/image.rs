#![allow(missing_docs)]

use crate::error::Result;
use crate::providers::client::{ElizaCloudClient, ImageDescriptionInput, ImageResult};
use crate::types::{ElizaCloudConfig, ImageDescriptionResult, ImageGenerationParams};

pub async fn handle_image_generation(
    config: ElizaCloudConfig,
    params: ImageGenerationParams,
) -> Result<Vec<ImageResult>> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_image(params).await
}

pub async fn handle_image_description<T: Into<ImageDescriptionInput>>(
    config: ElizaCloudConfig,
    input: T,
) -> Result<ImageDescriptionResult> {
    let client = ElizaCloudClient::new(config)?;
    client.describe_image(input.into()).await
}
