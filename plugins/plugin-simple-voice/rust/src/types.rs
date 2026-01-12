#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SamTTSOptions {
    pub speed: u8,
    pub pitch: u8,
    pub throat: u8,
    pub mouth: u8,
}

impl Default for SamTTSOptions {
    fn default() -> Self {
        DEFAULT_SAM_OPTIONS
    }
}

pub const DEFAULT_SAM_OPTIONS: SamTTSOptions = SamTTSOptions {
    speed: 72,
    pitch: 64,
    throat: 128,
    mouth: 128,
};

pub const SAM_SERVICE_TYPE: &str = "SAM_TTS";

pub const SPEECH_TRIGGERS: &[&str] = &[
    "say aloud",
    "speak",
    "read aloud",
    "say out loud",
    "voice",
    "speak this",
    "say this",
    "read this",
    "announce",
    "proclaim",
    "tell everyone",
    "speak up",
    "use your voice",
    "talk to me",
    "higher voice",
    "lower voice",
    "change voice",
    "robotic voice",
    "retro voice",
];

pub const VOCALIZATION_PATTERNS: &[&str] =
    &["can you say", "please say", "i want to hear", "let me hear"];

#[async_trait::async_trait]
pub trait HardwareBridge: Send + Sync {
    async fn send_audio_data(
        &self,
        audio_buffer: &[u8],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryContent {
    pub text: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub id: String,
    pub entity_id: String,
    pub agent_id: String,
    pub room_id: String,
    pub content: MemoryContent,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallbackResult {
    pub text: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_data: Option<Vec<u8>>,
}
