//! Type definitions for the Edge TTS plugin.

use std::env;

use serde::Serialize;
use thiserror::Error;

/// Errors produced by the Edge TTS plugin.
#[derive(Debug, Error)]
pub enum EdgeTTSError {
    #[error("Connection error: {0}")]
    /// WebSocket connection failed.
    Connection(String),

    #[error("Invalid input: {0}")]
    /// Caller-provided input was invalid.
    InvalidInput(String),

    #[error("Empty response from Edge TTS service")]
    /// The service returned no audio data.
    EmptyResponse,

    #[error("WebSocket error: {0}")]
    /// WebSocket protocol error.
    WebSocket(String),

    #[error("Serialization error: {0}")]
    /// JSON (de)serialization failed.
    Serialization(#[from] serde_json::Error),
}

/// Default TTS voice identifier.
pub const DEFAULT_VOICE: &str = "en-US-MichelleNeural";
/// Default language/locale for speech synthesis.
pub const DEFAULT_LANG: &str = "en-US";
/// Default audio output format.
pub const DEFAULT_OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
/// Default WebSocket connection timeout in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 30000;
/// Maximum number of characters allowed per synthesis request.
pub const MAX_TEXT_LENGTH: usize = 5000;

/// Maps OpenAI-style voice names to Edge TTS voice IDs.
pub const VOICE_PRESETS: &[(&str, &str)] = &[
    ("alloy", "en-US-GuyNeural"),
    ("echo", "en-US-ChristopherNeural"),
    ("fable", "en-GB-RyanNeural"),
    ("onyx", "en-US-DavisNeural"),
    ("nova", "en-US-JennyNeural"),
    ("shimmer", "en-US-AriaNeural"),
];

/// All output audio formats supported by the Edge TTS service.
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

/// Frequently used Edge TTS neural voice identifiers.
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

/// Edge TTS voice settings.
#[derive(Debug, Clone)]
pub struct EdgeTTSSettings {
    /// Voice identifier (e.g. `"en-US-MichelleNeural"`).
    pub voice: String,
    /// Language/locale code (e.g. `"en-US"`).
    pub lang: String,
    /// Audio output format string.
    pub output_format: String,
    /// Speech rate adjustment, e.g. `"+10%"`, `"-5%"`.
    pub rate: Option<String>,
    /// Pitch adjustment, e.g. `"+5Hz"`, `"-10Hz"`.
    pub pitch: Option<String>,
    /// Volume adjustment, e.g. `"+20%"`, `"-10%"`.
    pub volume: Option<String>,
    /// Optional HTTP/SOCKS proxy URL for WebSocket connections.
    pub proxy: Option<String>,
    /// WebSocket connection timeout in milliseconds.
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
    /// Load settings from `EDGE_TTS_*` environment variables.
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

/// Per-call TTS parameters (all optional except `text`).
#[derive(Debug, Clone, Default)]
pub struct EdgeTTSParams {
    /// The text to synthesize into speech.
    pub text: String,
    /// Override voice identifier for this request.
    pub voice: Option<String>,
    /// Speed multiplier (1.0 = normal speed).
    pub speed: Option<f64>,
    /// Override language/locale for this request.
    pub lang: Option<String>,
    /// Override audio output format for this request.
    pub output_format: Option<String>,
    /// Override speech rate (e.g. `"+50%"`).
    pub rate: Option<String>,
    /// Override pitch (e.g. `"+5Hz"`).
    pub pitch: Option<String>,
    /// Override volume (e.g. `"+20%"`).
    pub volume: Option<String>,
}

/// Map OpenAI-style voice names to Edge TTS voice IDs, falling back to `default_voice`.
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

/// Convert a speed multiplier (1.0 = normal) to a rate string like `"+50%"`.
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

/// Return a file extension (e.g. `".mp3"`) for the given Edge TTS output format string.
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

/// Escape special XML characters (`&`, `<`, `>`, `"`, `'`) in `text`.
pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// WebSocket speech.config payload.
#[derive(Debug, Serialize)]
pub(crate) struct SpeechConfig {
    pub context: SpeechConfigContext,
}

#[derive(Debug, Serialize)]
pub(crate) struct SpeechConfigContext {
    pub synthesis: SynthesisOptions,
}

#[derive(Debug, Serialize)]
pub(crate) struct SynthesisOptions {
    pub audio: AudioOptions,
}

#[derive(Debug, Serialize)]
pub(crate) struct AudioOptions {
    #[serde(rename = "metadataOptions")]
    pub metadata_options: MetadataOptions,
    #[serde(rename = "outputFormat")]
    pub output_format: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct MetadataOptions {
    #[serde(rename = "sentenceBoundaryEnabled")]
    pub sentence_boundary_enabled: String,
    #[serde(rename = "wordBoundaryEnabled")]
    pub word_boundary_enabled: String,
}
