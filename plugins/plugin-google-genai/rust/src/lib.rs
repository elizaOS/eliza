//! Google GenAI plugin for ElizaOS.
//!
//! This crate provides a client for interacting with Google's Generative AI (Gemini) API,
//! supporting text generation, embeddings, and image analysis capabilities.

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod models;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::GoogleGenAIClient;
pub use config::GoogleGenAIConfig;
pub use error::{GoogleGenAIError, Result};
pub use models::{Model, ModelSize};
pub use types::{
    EmbeddingParams, EmbeddingResponse, ObjectGenerationParams, TextGenerationParams,
    TextGenerationResponse,
};

/// Creates a new Google GenAI client using configuration from environment variables.
///
/// This is a convenience function that reads the API key and other settings
/// from environment variables and creates a configured client instance.
///
/// # Errors
///
/// Returns an error if required environment variables are missing or invalid.
pub fn create_client_from_env() -> Result<GoogleGenAIClient> {
    let config = GoogleGenAIConfig::from_env()?;
    GoogleGenAIClient::new(config)
}

/// The name identifier for this plugin.
pub const PLUGIN_NAME: &str = "google-genai";

/// A human-readable description of this plugin's functionality.
pub const PLUGIN_DESCRIPTION: &str =
    "Google GenAI Gemini API client with text generation, embeddings, and image analysis support";

/// The version of this plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
