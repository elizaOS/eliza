//! Ollama plugin for ElizaOS.
//!
//! This crate provides an Ollama API client with text generation, object generation,
//! and embedding support for the ElizaOS framework.

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::OllamaClient;
pub use config::OllamaConfig;
pub use error::{OllamaError, Result};
pub use types::{EmbeddingParams, ObjectGenerationParams, TextGenerationParams};

/// Creates an Ollama client using configuration from environment variables.
///
/// # Errors
///
/// Returns an error if the configuration cannot be loaded from the environment
/// or if the client fails to initialize.
pub fn create_client_from_env() -> Result<OllamaClient> {
    let config = OllamaConfig::from_env()?;
    OllamaClient::new(config)
}

/// The name of this plugin.
pub const PLUGIN_NAME: &str = "ollama";
/// A description of this plugin's functionality.
pub const PLUGIN_DESCRIPTION: &str =
    "Ollama API client with text generation, object generation, and embedding support";
/// The version of this plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
