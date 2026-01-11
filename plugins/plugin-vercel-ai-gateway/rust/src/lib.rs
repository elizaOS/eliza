#![allow(missing_docs)]
//! elizaOS Vercel AI Gateway Plugin
//!
//! This crate provides Vercel AI Gateway integration for elizaOS agents.
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_gateway::get_gateway_plugin;
//!
//! # async fn example() -> anyhow::Result<()> {
//! let plugin = get_gateway_plugin()?;
//! let response = plugin.generate_text("Hello, world!").await?;
//! println!("{}", response);
//! # Ok(())
//! # }
//! ```
//!
//! # Streaming Example
//!
//! ```rust,no_run
//! use elizaos_plugin_gateway::{get_gateway_plugin, TextGenerationParams};
//! use futures::StreamExt;
//!
//! # async fn example() -> anyhow::Result<()> {
//! let plugin = get_gateway_plugin()?;
//! let params = TextGenerationParams::new("Tell me a story");
//! let mut stream = plugin.stream_text(&params).await?;
//!
//! while let Some(chunk) = stream.next().await {
//!     match chunk {
//!         Ok(text) => print!("{}", text),
//!         Err(e) => eprintln!("Error: {}", e),
//!     }
//! }
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

// Import directly from submodules:
// - client::GatewayClient
// - config::model_supports_temperature
// - error::{GatewayError, Result}
// - types::* for all types
// - futures for stream handling

use anyhow::Result as AnyhowResult;

/// Vercel AI Gateway plugin for elizaOS.
///
/// This struct wraps the Gateway client and provides a simple interface
/// for text generation and other API calls.
pub struct GatewayPlugin {
    client: GatewayClient,
}

impl GatewayPlugin {
    /// Create a new GatewayPlugin with the given configuration.
    pub fn new(config: GatewayConfig) -> Result<Self> {
        let client = GatewayClient::new(config)?;
        Ok(Self { client })
    }

    /// Generate text from a prompt.
    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        self.client.generate_text(&params).await
    }

    /// Generate text with a system message.
    pub async fn generate_text_with_system(&self, prompt: &str, system: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt).system(system);
        self.client.generate_text(&params).await
    }

    /// Generate text with full parameters.
    pub async fn generate_text_with_params(&self, params: &TextGenerationParams) -> Result<String> {
        self.client.generate_text(params).await
    }

    /// Stream text generation from a prompt.
    ///
    /// Returns a stream of text chunks that can be processed as they arrive.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// use futures::StreamExt;
    ///
    /// let params = TextGenerationParams::new("Tell me a story");
    /// let mut stream = plugin.stream_text(&params).await?;
    ///
    /// while let Some(chunk) = stream.next().await {
    ///     print!("{}", chunk?);
    /// }
    /// ```
    pub async fn stream_text(
        &self,
        params: &TextGenerationParams,
    ) -> Result<impl futures::Stream<Item = Result<String>>> {
        self.client.stream_text(params).await
    }

    /// Stream text generation with just a prompt string.
    ///
    /// Convenience method for streaming with default parameters.
    pub async fn stream_text_simple(
        &self,
        prompt: &str,
    ) -> Result<impl futures::Stream<Item = Result<String>>> {
        let params = TextGenerationParams::new(prompt);
        self.client.stream_text(&params).await
    }

    /// Create an embedding for text.
    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.client.create_embedding(&params).await
    }

    /// Generate images.
    pub async fn generate_image(
        &self,
        params: &ImageGenerationParams,
    ) -> Result<Vec<ImageGenerationResult>> {
        self.client.generate_image(params).await
    }

    /// Describe/analyze an image.
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

    /// Get the underlying client for advanced operations.
    pub fn client(&self) -> &GatewayClient {
        &self.client
    }
}

/// Create a Gateway plugin from environment variables.
///
/// Required environment variables:
/// - `AI_GATEWAY_API_KEY` or `AIGATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`: API key
///
/// Optional environment variables:
/// - `AI_GATEWAY_BASE_URL`: Custom API endpoint
/// - `AI_GATEWAY_SMALL_MODEL`: Model for small tasks (default: gpt-5-mini)
/// - `AI_GATEWAY_LARGE_MODEL`: Model for large tasks (default: gpt-5)
pub fn get_gateway_plugin() -> AnyhowResult<GatewayPlugin> {
    let config = GatewayConfig::from_env()
        .map_err(|e| anyhow::anyhow!("Failed to load Gateway config: {}", e))?;

    GatewayPlugin::new(config).map_err(|e| anyhow::anyhow!("Failed to create Gateway plugin: {}", e))
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "gateway";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Vercel AI Gateway plugin with text, embedding, and image generation support";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

