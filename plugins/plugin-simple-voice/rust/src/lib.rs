//! Eliza Plugin Simple Voice - Retro SAM TTS

pub mod types;
pub mod sam_engine;
pub mod services;
pub mod actions;
pub mod plugin;

pub use types::{SamTTSOptions, DEFAULT_SAM_OPTIONS, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS};
pub use sam_engine::SamEngine;
pub use services::SamTTSService;
pub use actions::{SayAloudAction, extract_text_to_speak, extract_voice_options};
pub use plugin::SimpleVoicePlugin;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
