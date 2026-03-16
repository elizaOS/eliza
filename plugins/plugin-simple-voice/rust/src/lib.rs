#![allow(missing_docs)]

pub mod actions;
pub mod plugin;
pub mod sam_engine;
pub mod services;
pub mod types;

pub use actions::{extract_text_to_speak, extract_voice_options, SayAloudAction};
pub use plugin::SimpleVoicePlugin;
pub use sam_engine::SamEngine;
pub use services::SamTTSService;
pub use types::{SamTTSOptions, DEFAULT_SAM_OPTIONS, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
