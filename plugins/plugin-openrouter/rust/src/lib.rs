//! elizaOS Plugin OpenRouter - Rust Implementation
//!
//! This crate provides an OpenRouter API client for elizaOS,
//! supporting text generation, object generation, and embeddings
//! through multiple AI providers.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_openrouter::{OpenRouterClient, OpenRouterConfig, TextGenerationParams};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = OpenRouterConfig::from_env()?;
//!     let client = OpenRouterClient::new(config)?;
//!
//!     let params = TextGenerationParams::new("What is the meaning of life?");
//!     let response = client.generate_text_large(params).await?;
//!     println!("Response: {}", response.text);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export main types
pub use client::OpenRouterClient;
pub use config::OpenRouterConfig;
pub use error::{OpenRouterError, Result};
pub use types::{
    EmbeddingParams, EmbeddingResponse, ObjectGenerationParams, ObjectGenerationResponse,
    TextGenerationParams, TextGenerationResponse, TokenUsage,
};

/// Create an OpenRouter client from environment variables.
///
/// # Errors
///
/// Returns an error if OPENROUTER_API_KEY is not set.
pub fn create_client_from_env() -> Result<OpenRouterClient> {
    let config = OpenRouterConfig::from_env()?;
    OpenRouterClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "openrouter";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "OpenRouter multi-model AI gateway with text, object generation, and embedding support";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");


