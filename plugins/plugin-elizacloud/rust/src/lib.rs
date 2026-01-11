#![allow(missing_docs)]
//! # elizaOS Plugin ElizaCloud
//!
//! Rust implementation of the ElizaOS Cloud plugin for multi-model AI generation.
//!
//! This crate provides:
//! - Text generation (small and large models)
//! - Structured object generation (small and large models)
//! - Text embeddings with batch support
//! - Image generation and description
//! - Text-to-speech generation
//! - Audio transcription
//! - Tokenization utilities
//!
//! ## Features
//!
//! - `native` (default): Enables native async runtime with tokio
//! - `wasm`: Enables WebAssembly support with wasm-bindgen
//!
//! ## Example
//!
//! ```rust,ignore
//! use elizaos_plugin_elizacloud::{
//!     ElizaCloudClient, ElizaCloudConfig, TextGenerationParams, ObjectGenerationParams,
//!     handle_object_large, handle_tokenizer_encode, TokenizeTextParams,
//! };
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = ElizaCloudConfig::new("eliza_xxxxx");
//!     let client = ElizaCloudClient::new(config.clone())?;
//!     
//!     // Text generation
//!     let text = client.generate_text_small(TextGenerationParams {
//!         prompt: "What is the meaning of life?".to_string(),
//!         ..Default::default()
//!     }).await?;
//!     println!("Generated: {}", text);
//!     
//!     // Structured object generation
//!     let obj = handle_object_large(config.clone(), ObjectGenerationParams {
//!         prompt: "Generate a user profile with name and age".to_string(),
//!         ..Default::default()
//!     }).await?;
//!     println!("Object: {}", obj);
//!     
//!     // Tokenization
//!     let tokens = handle_tokenizer_encode(config, TokenizeTextParams {
//!         prompt: "Hello tokenizer!".to_string(),
//!         ..Default::default()
//!     }).await?;
//!     println!("Tokens: {:?}", tokens);
//!     
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod error;
pub mod models;
pub mod providers;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Import directly from submodules:
// - types::* for all types
// - error::{ElizaCloudError, ElizaCloudErrorCode}
// - providers::client::{ElizaCloudClient, ImageDescriptionInput, ImageResult}
// - models::{handle_text_embedding, handle_text_small, handle_text_large, etc.}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "elizacloud";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
