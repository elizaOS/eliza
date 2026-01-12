//! OpenRouter multi-model AI gateway plugin for ElizaOS.
//!
//! Provides text generation, object generation, and embedding support
//! through the OpenRouter API gateway.

#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::OpenRouterClient;
pub use config::OpenRouterConfig;
pub use error::{OpenRouterError, Result};
pub use types::{
    EmbeddingParams, EmbeddingResponse, ObjectGenerationParams, ObjectGenerationResponse,
    TextGenerationParams, TextGenerationResponse,
};

/// Creates an OpenRouter client from environment variables.
///
/// Reads configuration from environment and initializes a new client.
pub fn create_client_from_env() -> Result<OpenRouterClient> {
    let config = OpenRouterConfig::from_env()?;
    OpenRouterClient::new(config)
}

/// The plugin name identifier.
pub const PLUGIN_NAME: &str = "openrouter";
/// Human-readable description of the plugin's functionality.
pub const PLUGIN_DESCRIPTION: &str =
    "OpenRouter multi-model AI gateway with text, object generation, and embedding support";
/// Current version of the plugin from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");



