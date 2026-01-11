#![allow(missing_docs)]
//! elizaOS Plugin Google GenAI - Rust Implementation
//!
//! This crate provides a Google Generative AI (Gemini) API client for elizaOS,
//! supporting text generation, embeddings, image analysis, and structured JSON object generation.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_google_genai::{GoogleGenAIClient, GoogleGenAIConfig, TextGenerationParams};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = GoogleGenAIConfig::from_env()?;
//!     let client = GoogleGenAIClient::new(config)?;
//!
//!     let params = TextGenerationParams {
//!         prompt: "What is the meaning of life?".to_string(),
//!         max_tokens: Some(1024),
//!         temperature: Some(0.7),
//!         ..Default::default()
//!     };
//!
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
pub mod models;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export commonly used types for convenience
pub use client::GoogleGenAIClient;
pub use config::GoogleGenAIConfig;
pub use error::{GoogleGenAIError, Result};
pub use models::{Model, ModelSize};
pub use types::{
    EmbeddingParams, EmbeddingResponse, ObjectGenerationParams, TextGenerationParams,
    TextGenerationResponse,
};

/// Create a Google GenAI client from environment variables.
///
/// # Errors
///
/// Returns an error if GOOGLE_GENERATIVE_AI_API_KEY is not set.
pub fn create_client_from_env() -> Result<GoogleGenAIClient> {
    let config = GoogleGenAIConfig::from_env()?;
    GoogleGenAIClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "google-genai";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Google GenAI Gemini API client with text generation, embeddings, and image analysis support";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");







