//! Anthropic Claude API client library for text and object generation.
//!
//! This crate provides a Rust client for interacting with Anthropic's Claude API,
//! supporting both text generation and structured JSON object generation.
//!
//! # Example
//!
//! ```no_run
//! use elizaos_plugin_anthropic::{create_client_from_env, TextGenerationParams};
//!
//! # async fn example() -> elizaos_plugin_anthropic::Result<()> {
//! let client = create_client_from_env()?;
//! let params = TextGenerationParams::new("Hello, Claude!");
//! let response = client.generate_text_small(params).await?;
//! println!("{}", response.text);
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// HTTP client for making API requests to Anthropic.
pub mod client;
/// Configuration types for the Anthropic client.
pub mod config;
/// Error types for API operations.
pub mod error;
/// Model definitions and utilities.
pub mod models;
/// Request and response types for the API.
pub mod types;

#[cfg(feature = "wasm")]
/// WebAssembly bindings for browser usage.
pub mod wasm;

pub use client::AnthropicClient;
pub use config::AnthropicConfig;
pub use error::{AnthropicError, Result};
pub use models::{Model, ModelSize};
pub use types::{
    ContentBlock, Message, ObjectGenerationParams, Role, TextGenerationParams,
    TextGenerationResponse,
};

/// Creates an Anthropic client using environment variables for configuration.
///
/// This function reads the `ANTHROPIC_API_KEY` environment variable and optionally
/// `ANTHROPIC_BASE_URL`, `ANTHROPIC_SMALL_MODEL`, `ANTHROPIC_LARGE_MODEL`, and
/// `ANTHROPIC_TIMEOUT_SECONDS` for additional configuration.
///
/// # Errors
///
/// Returns an error if the `ANTHROPIC_API_KEY` environment variable is not set
/// or if the client cannot be initialized.
pub fn create_client_from_env() -> Result<AnthropicClient> {
    let config = AnthropicConfig::from_env()?;
    AnthropicClient::new(config)
}

/// The name of this plugin.
pub const PLUGIN_NAME: &str = "anthropic";
/// A description of this plugin's functionality.
pub const PLUGIN_DESCRIPTION: &str =
    "Anthropic Claude API client with text and object generation support";
/// The version of this plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
