#![allow(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod error;
pub mod types;

pub use client::GroqClient;
pub use error::{GroqError, GroqErrorCode};
pub use types::*;

pub const PLUGIN_NAME: &str = "groq";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_BASE_URL: &str = "https://api.groq.com/openai/v1";
pub const DEFAULT_SMALL_MODEL: &str = "llama-3.1-8b-instant";
pub const DEFAULT_LARGE_MODEL: &str = "llama-3.3-70b-versatile";
pub const DEFAULT_TTS_MODEL: &str = "playai-tts";
pub const DEFAULT_TTS_VOICE: &str = "Chip-PlayAI";
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "distil-whisper-large-v3-en";
