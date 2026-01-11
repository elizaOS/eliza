#![allow(missing_docs)]
//! elizaOS Plugin Ollama - Rust Implementation
//!
//! This crate provides an Ollama API client for elizaOS,
//! supporting text generation, object generation, and embeddings
//! using locally-hosted models.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_ollama::{OllamaClient, OllamaConfig, TextGenerationParams};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = OllamaConfig::from_env()?;
//!     let client = OllamaClient::new(config)?;
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

// Re-export commonly used types for convenience
pub use client::OllamaClient;
pub use config::OllamaConfig;
pub use error::{OllamaError, Result};

/// Create an Ollama client from environment variables.
///
/// # Errors
///
/// Returns an error if required environment variables are not set.
pub fn create_client_from_env() -> Result<OllamaClient> {
    let config = OllamaConfig::from_env()?;
    OllamaClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "ollama";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Ollama API client with text generation, object generation, and embedding support";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");




