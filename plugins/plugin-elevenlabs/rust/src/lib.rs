//! ElevenLabs plugin for ElizaOS - High-quality TTS and STT.
//!
//! This crate provides text-to-speech (TTS) and speech-to-text (STT) capabilities
//! using the ElevenLabs API.

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod plugin;
pub mod services;
pub mod types;

pub use plugin::ElevenLabsPlugin;
pub use services::ElevenLabsService;
pub use types::{
    ElevenLabsError, ElevenLabsSTTOptions, ElevenLabsTTSOptions, TranscriptionSettings,
    VoiceSettings, DEFAULT_STT_OPTIONS, DEFAULT_TTS_OPTIONS,
};

/// Crate version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
