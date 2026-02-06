//! Type definitions for the Edge TTS plugin.

use std::env;

use serde::Serialize;
use thiserror::Error;

/// Errors that can occur when using the Edge TTS plugin.
#[derive(Debug, Error)]
pub enum EdgeTTSError {
    /// WebSocket connection error.
    #[error("Connection error: {0}")]
    Connection(String),

    /// Invalid input.
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// Empty response from service.
    #[error("Empty response from Edge TTS service")]
    EmptyResponse,

    /// WebSocket protocol error.
    #[error("WebSocket error: {0}")]
    WebSocket(String),

    /// Serialization error.
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// Default voice ID.
pub const DEFAULT_VOICE: &str = "en-US-MichelleNeural";

/// Default language code.
pub const DEFAULT_LANG: &str = "en-US";

/// Default output format.
pub const DEFAULT_OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";

/// Default timeout in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 30000;

/// Maximum text length.
pub const MAX_TEXT_LENGTH: usize = 5000;

/// Voice presets mapping common voice names to Edge TTS voices.
pub const VOICE_PRESETS: &[(&str, &str)] = &[
    ("alloy", "en-US-GuyNeural"),
    ("echo", "en-US-ChristopherNeural"),
    ("fable", "en-GB-RyanNeural"),
    ("onyx", "en-US-DavisNeural"),
    ("nova", "en-US-JennyNeural"),
    ("shimmer", "en-US-AriaNeural"),
];

/// Supported output formats.
pub const SUPPORTED_OUTPUT_FORMATS: &[&str] = &[
    "audio-24khz-48kbitrate-mono-mp3",
    "audio-24khz-96kbitrate-mono-mp3",
    "audio-48khz-96kbitrate-mono-mp3",
    "audio-48khz-192kbitrate-mono-mp3",
    "webm-24khz-16bit-mono-opus",
    "ogg-24khz-16bit-mono-opus",
    "ogg-48khz-16bit-mono-opus",
    "riff-8khz-16bit-mono-pcm",
    "riff-24khz-16bit-mono-pcm",
    "riff-48khz-16bit-mono-pcm",
];

/// Popular voices.
pub const POPULAR_VOICES: &[&str] = &[
    "en-US-MichelleNeural",
    "en-US-GuyNeural",
    "en-US-JennyNeural",
    "en-US-AriaNeural",
    "en-US-ChristopherNeural",
    "en-US-DavisNeural",
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
    "de-DE-KatjaNeural",
    "fr-FR-DeniseNeural",
    "es-ES-ElviraNeural",
    "ja-JP-NanamiNeural",
    "zh-CN-XiaoxiaoNeural",
];

/// Edge TTS voice settings configuration.
#[derive(Debug, Clone)]
pub struct EdgeTTSSettings {
    /// Voice ID for TTS generation.
    pub voice: String,
    /// Language code.
    pub lang: String,
    /// Output audio format.
    pub output_format: String,
    /// Speech rate adjustment (e.g., "+10%", "-5%").
    pub rate: Option<String>,
    /// Pitch adjustment (e.g., "+5Hz", "-10Hz").
    pub pitch: Option<String>,
    /// Volume adjustment (e.g., "+20%", "-10%").
    pub volume: Option<String>,
    /// HTTP proxy URL.
    pub proxy: Option<String>,
    /// Request timeout in milliseconds.
    pub timeout_ms: u64,
}

impl Default for EdgeTTSSettings {
    fn default() -> Self {
        Self {
            voice: DEFAULT_VOICE.to_string(),
            lang: DEFAULT_LANG.to_string(),
            output_format: DEFAULT_OUTPUT_FORMAT.to_string(),
            rate: None,
            pitch: None,
            volume: None,
            proxy: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

impl EdgeTTSSettings {
    /// Create settings from environment variables.
    pub fn from_env() -> Self {
        Self {
            voice: env::var("EDGE_TTS_VOICE").unwrap_or_else(|_| DEFAULT_VOICE.to_string()),
            lang: env::var("EDGE_TTS_LANG").unwrap_or_else(|_| DEFAULT_LANG.to_string()),
            output_format: env::var("EDGE_TTS_OUTPUT_FORMAT")
                .unwrap_or_else(|_| DEFAULT_OUTPUT_FORMAT.to_string()),
            rate: env::var("EDGE_TTS_RATE").ok(),
            pitch: env::var("EDGE_TTS_PITCH").ok(),
            volume: env::var("EDGE_TTS_VOLUME").ok(),
            proxy: env::var("EDGE_TTS_PROXY").ok(),
            timeout_ms: env::var("EDGE_TTS_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_TIMEOUT_MS),
        }
    }
}

/// Extended TTS params with Edge-specific options.
#[derive(Debug, Clone, Default)]
pub struct EdgeTTSParams {
    /// Text to convert to speech.
    pub text: String,
    /// Voice name or ID.
    pub voice: Option<String>,
    /// Speed multiplier (1.0 = normal).
    pub speed: Option<f64>,
    /// Language code.
    pub lang: Option<String>,
    /// Output audio format.
    pub output_format: Option<String>,
    /// Rate adjustment string.
    pub rate: Option<String>,
    /// Pitch adjustment string.
    pub pitch: Option<String>,
    /// Volume adjustment string.
    pub volume: Option<String>,
}

/// Resolve voice name - handles OpenAI-style voice names and Edge TTS voice IDs.
///
/// # Arguments
///
/// * `voice` - Voice name or ID to resolve
/// * `default_voice` - Default voice to use if voice is None or empty
///
/// # Returns
///
/// Resolved Edge TTS voice ID.
pub fn resolve_voice(voice: Option<&str>, default_voice: &str) -> String {
    match voice {
        None | Some("") => default_voice.to_string(),
        Some(v) => {
            let lower = v.to_lowercase();
            for (preset_name, preset_voice) in VOICE_PRESETS {
                if lower == *preset_name {
                    return preset_voice.to_string();
                }
            }
            v.to_string()
        }
    }
}

/// Convert speed multiplier to Edge TTS rate string.
///
/// Speed: 1.0 = normal, 0.5 = half speed, 2.0 = double speed.
///
/// # Arguments
///
/// * `speed` - Speed multiplier
///
/// # Returns
///
/// Rate string (e.g., "+50%", "-25%") or None if speed is 1.0 or None.
pub fn speed_to_rate(speed: Option<f64>) -> Option<String> {
    match speed {
        Some(s) if (s - 1.0).abs() > f64::EPSILON => {
            let percentage = ((s - 1.0) * 100.0).round() as i32;
            if percentage >= 0 {
                Some(format!("+{}%", percentage))
            } else {
                Some(format!("{}%", percentage))
            }
        }
        _ => None,
    }
}

/// Infer file extension from Edge TTS output format.
///
/// # Arguments
///
/// * `output_format` - The Edge TTS output format string
///
/// # Returns
///
/// File extension including the dot (e.g., ".mp3").
pub fn infer_extension(output_format: &str) -> &'static str {
    let normalized = output_format.to_lowercase();
    if normalized.contains("webm") {
        ".webm"
    } else if normalized.contains("ogg") {
        ".ogg"
    } else if normalized.contains("opus") && !normalized.contains("ogg") {
        ".opus"
    } else if normalized.contains("wav")
        || normalized.contains("riff")
        || normalized.contains("pcm")
    {
        ".wav"
    } else {
        ".mp3"
    }
}

/// Escape special XML characters in text.
pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Speech configuration sent over WebSocket.
#[derive(Debug, Serialize)]
pub(crate) struct SpeechConfig {
    /// Synthesis context.
    pub context: SpeechConfigContext,
}

/// Speech configuration context.
#[derive(Debug, Serialize)]
pub(crate) struct SpeechConfigContext {
    /// Synthesis options.
    pub synthesis: SynthesisOptions,
}

/// Synthesis options.
#[derive(Debug, Serialize)]
pub(crate) struct SynthesisOptions {
    /// Audio options.
    pub audio: AudioOptions,
}

/// Audio options.
#[derive(Debug, Serialize)]
pub(crate) struct AudioOptions {
    /// Metadata options.
    #[serde(rename = "metadataOptions")]
    pub metadata_options: MetadataOptions,
    /// Output format.
    #[serde(rename = "outputFormat")]
    pub output_format: String,
}

/// Metadata options.
#[derive(Debug, Serialize)]
pub(crate) struct MetadataOptions {
    /// Enable sentence boundary detection.
    #[serde(rename = "sentenceBoundaryEnabled")]
    pub sentence_boundary_enabled: String,
    /// Enable word boundary detection.
    #[serde(rename = "wordBoundaryEnabled")]
    pub word_boundary_enabled: String,
}
