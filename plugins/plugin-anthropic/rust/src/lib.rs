//! elizaOS Plugin Anthropic - Rust Implementation
//!
//! This crate provides an Anthropic Claude API client for elizaOS,
//! supporting both text generation and structured JSON object generation.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_anthropic::{AnthropicClient, AnthropicConfig, TextGenerationParams};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = AnthropicConfig::from_env()?;
//!     let client = AnthropicClient::new(config)?;
//!
//!     let params = TextGenerationParams {
//!         prompt: "What is the meaning of life?".to_string(),
//!         max_tokens: Some(1024),
//!         temperature: Some(0.7),
//!         ..Default::default()
//!     };
//!
//!     let response = client.generate_text(params).await?;
//!     println!("Response: {}", response.text);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod models;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Import directly from submodules:
// - client::AnthropicClient
// - config::AnthropicConfig
// - error::{AnthropicError, Result}
// - models::{Model, ModelSize}
// - types::{ContentBlock, Message, ObjectGenerationParams, Role, TextGenerationParams, TextGenerationResponse}

/// Create an Anthropic client from environment variables.
///
/// # Errors
///
/// Returns an error if ANTHROPIC_API_KEY is not set.
pub fn create_client_from_env() -> Result<AnthropicClient> {
    let config = AnthropicConfig::from_env()?;
    AnthropicClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "anthropic";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Anthropic Claude API client with text and object generation support";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");


