//! Type definitions for the ElevenLabs plugin.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors that can occur when using the ElevenLabs plugin.
#[derive(Debug, Error)]
pub enum ElevenLabsError {
    /// HTTP request error
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// API error response
    #[error("API error: {0}")]
    Api(String),

    /// Invalid configuration
    #[error("Invalid configuration: {0}")]
    Config(String),

    /// Missing API key
    #[error("Missing API key")]
    MissingApiKey,

    /// Serialization error
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// Voice settings configuration for ElevenLabs TTS API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceSettings {
    /// Voice stability factor (0-1) influencing consistency of speech.
    pub stability: f32,
    /// Similarity boost factor (0-1) affecting how closely the voice matches the target.
    #[serde(rename = "similarity_boost")]
    pub similarity_boost: f32,
    /// Style intensity (0-1) for the generated voice.
    pub style: f32,
    /// Flag to enable or disable speaker boost feature.
    #[serde(rename = "use_speaker_boost")]
    pub use_speaker_boost: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
        }
    }
}

/// Options for text-to-speech generation.
#[derive(Debug, Clone)]
pub struct ElevenLabsTTSOptions {
    /// ElevenLabs API key.
    pub api_key: String,
    /// Voice ID for TTS generation.
    pub voice_id: String,
    /// Model ID for TTS generation.
    pub model_id: String,
    /// Audio output format.
    pub output_format: String,
    /// Latency optimization level (0-4).
    pub optimize_streaming_latency: u8,
    /// Voice settings.
    pub voice_settings: VoiceSettings,
}

impl Default for ElevenLabsTTSOptions {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            voice_id: "EXAVITQu4vr4xnSDxMaL".to_string(),
            model_id: "eleven_monolingual_v1".to_string(),
            output_format: "mp3_44100_128".to_string(),
            optimize_streaming_latency: 0,
            voice_settings: VoiceSettings::default(),
        }
    }
}

/// Settings for speech-to-text transcription.
#[derive(Debug, Clone, Default)]
pub struct TranscriptionSettings {
    /// Timestamp detail level: "none", "word", or "character".
    pub timestamps_granularity: String,
    /// Enable speaker diarization.
    pub diarize: bool,
    /// Expected number of speakers (1-32).
    pub num_speakers: Option<u8>,
    /// Tag audio events like laughter, applause, etc.
    pub tag_audio_events: bool,
}

/// Options for speech-to-text transcription.
#[derive(Debug, Clone)]
pub struct ElevenLabsSTTOptions {
    /// ElevenLabs API key.
    pub api_key: String,
    /// STT model ID.
    pub model_id: String,
    /// Language code for transcription.
    pub language_code: Option<String>,
    /// Transcription settings.
    pub transcription_settings: TranscriptionSettings,
}

impl Default for ElevenLabsSTTOptions {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            model_id: "scribe_v1".to_string(),
            language_code: None,
            transcription_settings: TranscriptionSettings {
                timestamps_granularity: "word".to_string(),
                diarize: false,
                num_speakers: None,
                tag_audio_events: false,
            },
        }
    }
}

/// Default TTS options.
pub static DEFAULT_TTS_OPTIONS: std::sync::LazyLock<ElevenLabsTTSOptions> =
    std::sync::LazyLock::new(ElevenLabsTTSOptions::default);

/// Default STT options.
pub static DEFAULT_STT_OPTIONS: std::sync::LazyLock<ElevenLabsSTTOptions> =
    std::sync::LazyLock::new(ElevenLabsSTTOptions::default);

/// TTS request payload sent to the ElevenLabs API.
#[derive(Debug, Serialize)]
pub(crate) struct TTSRequest {
    /// Text to convert to speech.
    pub text: String,
    /// Model ID to use.
    pub model_id: String,
    /// Output format.
    pub output_format: String,
    /// Voice settings.
    pub voice_settings: VoiceSettings,
}

/// STT response from the ElevenLabs API.
#[derive(Debug, Deserialize)]
pub(crate) struct STTResponse {
    /// Transcribed text.
    pub text: Option<String>,
    /// Transcript object (alternative format).
    pub transcript: Option<TranscriptObject>,
    /// Array of transcripts (multi-speaker format).
    pub transcripts: Option<Vec<TranscriptObject>>,
}

/// Transcript object in STT response.
#[derive(Debug, Deserialize)]
pub(crate) struct TranscriptObject {
    /// Transcribed text.
    pub text: Option<String>,
}

/// Supported TTS output formats.
pub const TTS_OUTPUT_FORMATS: &[&str] = &[
    "mp3_22050_32",
    "mp3_44100_32",
    "mp3_44100_64",
    "mp3_44100_96",
    "mp3_44100_128",
    "mp3_44100_192",
    "pcm_16000",
    "pcm_22050",
    "pcm_24000",
    "pcm_44100",
    "ulaw_8000",
];

/// Supported STT models.
pub const STT_MODELS: &[&str] = &["scribe_v1"];

/// Supported TTS models.
pub const TTS_MODELS: &[&str] = &[
    "eleven_monolingual_v1",
    "eleven_multilingual_v1",
    "eleven_multilingual_v2",
    "eleven_turbo_v2",
    "eleven_turbo_v2_5",
];
