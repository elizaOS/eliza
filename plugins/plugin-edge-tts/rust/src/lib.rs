//! Free text-to-speech using Microsoft Edge TTS. No API key required.
//!
//! ```no_run
//! use elizaos_plugin_edge_tts::EdgeTTSService;
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
