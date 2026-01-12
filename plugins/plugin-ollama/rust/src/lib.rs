//! elizaOS Ollama plugin (Rust).
//!
//! This crate provides an [`OllamaClient`] for interacting with an Ollama server, including text
//! generation, JSON/object generation, and embedding generation.

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Ollama HTTP client and request helpers.
pub mod client;
/// Configuration for connecting to an Ollama server.
pub mod config;
/// Error types and result aliases for this crate.
pub mod error;
/// Request/response types and parameter structs.
pub mod types;

/// WASM initialization helpers.
#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::OllamaClient;
pub use config::OllamaConfig;
pub use error::{OllamaError, Result};
pub use types::{EmbeddingParams, ObjectGenerationParams, TextGenerationParams};

/// Create an [`OllamaClient`] using environment-based configuration.
///
/// This loads an [`OllamaConfig`] via [`OllamaConfig::from_env`] and constructs an [`OllamaClient`]
/// with default headers and timeouts.
pub fn create_client_from_env() -> Result<OllamaClient> {
    let config = OllamaConfig::from_env()?;
    OllamaClient::new(config)
}

/// Canonical elizaOS plugin name.
pub const PLUGIN_NAME: &str = "ollama";
/// Short, human-readable plugin description.
pub const PLUGIN_DESCRIPTION: &str =
    "Ollama API client with text generation, object generation, and embedding support";
/// Plugin version, sourced from this crate’s `Cargo.toml`.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
