#![allow(missing_docs)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

// Re-export commonly used types for convenience
pub use client::GatewayClient;
pub use error::{GatewayError, Result};
pub use types::{
    EmbeddingParams, GatewayConfig, ImageDescriptionParams, ImageDescriptionResult,
    ImageGenerationParams, ImageGenerationResult, TextGenerationParams,
};

use anyhow::Result as AnyhowResult;

pub struct GatewayPlugin {
    client: GatewayClient,
}

impl GatewayPlugin {
    pub fn new(config: GatewayConfig) -> Result<Self> {
        let client = GatewayClient::new(config)?;
        Ok(Self { client })
    }

    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        self.client.generate_text(&params).await
    }

    pub async fn generate_text_with_system(&self, prompt: &str, system: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt).system(system);
        self.client.generate_text(&params).await
    }

    pub async fn generate_text_with_params(&self, params: &TextGenerationParams) -> Result<String> {
        self.client.generate_text(params).await
    }

    pub async fn stream_text(
        &self,
        params: &TextGenerationParams,
    ) -> Result<impl futures::Stream<Item = Result<String>>> {
        self.client.stream_text(params).await
    }

    pub async fn stream_text_simple(
        &self,
        prompt: &str,
    ) -> Result<impl futures::Stream<Item = Result<String>>> {
        let params = TextGenerationParams::new(prompt);
        self.client.stream_text(&params).await
    }

    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.client.create_embedding(&params).await
    }

    pub async fn generate_image(
        &self,
        params: &ImageGenerationParams,
    ) -> Result<Vec<ImageGenerationResult>> {
        self.client.generate_image(params).await
    }

    pub async fn describe_image(
        &self,
        params: &ImageDescriptionParams,
    ) -> Result<ImageDescriptionResult> {
        self.client.describe_image(params).await
    }

    /// Generate a structured JSON object.
    pub async fn generate_object(&self, prompt: &str) -> Result<serde_json::Value> {
        self.client.generate_object(prompt, None).await
    }

    pub fn client(&self) -> &GatewayClient {
        &self.client
    }
}

pub fn get_gateway_plugin() -> AnyhowResult<GatewayPlugin> {
    let config = GatewayConfig::from_env()
        .map_err(|e| anyhow::anyhow!("Failed to load Gateway config: {}", e))?;

    GatewayPlugin::new(config)
        .map_err(|e| anyhow::anyhow!("Failed to create Gateway plugin: {}", e))
}

pub const PLUGIN_NAME: &str = "gateway";
pub const PLUGIN_DESCRIPTION: &str =
    "Vercel AI Gateway plugin with text, embedding, and image generation support";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
