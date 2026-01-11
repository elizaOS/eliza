#![allow(missing_docs)]
//! # elizaOS Plugin Groq
//!
//! Rust implementation of the Groq LLM plugin for elizaOS.
//!
//! Provides fast inference with Llama and other models via Groq's LPU.
//!
//! ## Example
//!
//! ```rust,no_run
//! use elizaos_plugin_groq::{GroqClient, GenerateTextParams};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let client = GroqClient::new("your-api-key", None)?;
//!     
//!     let response = client.generate_text_large(GenerateTextParams {
//!         prompt: "What is the nature of reality?".to_string(),
//!         temperature: Some(0.7),
//!         max_tokens: Some(1024),
//!         ..Default::default()
//!     }).await?;
//!     
//!     println!("Response: {}", response);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod error;
pub mod types;

pub use client::GroqClient;
pub use error::{GroqError, GroqErrorCode};
pub use types::*;

/// Plugin name
pub const PLUGIN_NAME: &str = "groq";

/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default API base URL
pub const DEFAULT_BASE_URL: &str = "https://api.groq.com/openai/v1";

/// Default small model
pub const DEFAULT_SMALL_MODEL: &str = "llama-3.1-8b-instant";

/// Default large model  
pub const DEFAULT_LARGE_MODEL: &str = "llama-3.3-70b-versatile";

/// Default TTS model
pub const DEFAULT_TTS_MODEL: &str = "playai-tts";

/// Default TTS voice
pub const DEFAULT_TTS_VOICE: &str = "Chip-PlayAI";

/// Default transcription model
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "distil-whisper-large-v3-en";
