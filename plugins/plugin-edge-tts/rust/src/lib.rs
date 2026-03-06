//! Edge TTS plugin for elizaOS - Free text-to-speech using Microsoft Edge TTS.
//!
//! This crate provides text-to-speech (TTS) capabilities using Microsoft Edge's
//! TTS service. No API key required - uses the same TTS engine as Microsoft Edge browser.
//!
//! # Features
//!
//! - High-quality neural voices
//! - Multiple languages and locales
//! - Adjustable rate, pitch, and volume
//! - No API key or payment required
//! - Voice presets compatible with OpenAI voice names
//!
//! # Example
//!
//! ```no_run
//! use eliza_plugin_edge_tts::EdgeTTSService;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let service = EdgeTTSService::new();
//! let audio = service.text_to_speech("Hello, world!").await?;
//! println!("Generated {} bytes of audio", audio.len());
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod plugin;
pub mod services;
pub mod types;

pub use plugin::EdgeTTSPlugin;
pub use services::EdgeTTSService;
pub use types::{
    EdgeTTSError, EdgeTTSParams, EdgeTTSSettings, DEFAULT_LANG, DEFAULT_OUTPUT_FORMAT,
    DEFAULT_TIMEOUT_MS, DEFAULT_VOICE, MAX_TEXT_LENGTH, POPULAR_VOICES, SUPPORTED_OUTPUT_FORMATS,
    VOICE_PRESETS,
};

/// Crate version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
