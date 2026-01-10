//! Image generation and description model handlers.

use crate::error::Result;
use crate::providers::client::{ElizaCloudClient, ImageDescriptionInput, ImageResult};
use crate::types::{ElizaCloudConfig, ImageDescriptionResult, ImageGenerationParams};

/// Handle IMAGE model generation.
///
/// Uses ElizaOS Cloud's custom /generate-image endpoint.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `params` - Image generation parameters
///
/// # Returns
///
/// List of generated image results with URLs.
pub async fn handle_image_generation(
    config: ElizaCloudConfig,
    params: ImageGenerationParams,
) -> Result<Vec<ImageResult>> {
    let client = ElizaCloudClient::new(config)?;
    client.generate_image(params).await
}

/// Handle IMAGE_DESCRIPTION model.
///
/// Accepts either an image URL string or ImageDescriptionParams.
///
/// # Arguments
///
/// * `config` - ElizaOS Cloud configuration
/// * `input` - Image URL string or ImageDescriptionParams
///
/// # Returns
///
/// Image description with title and description.
pub async fn handle_image_description<T: Into<ImageDescriptionInput>>(
    config: ElizaCloudConfig,
    input: T,
) -> Result<ImageDescriptionResult> {
    let client = ElizaCloudClient::new(config)?;
    client.describe_image(input.into()).await
}
