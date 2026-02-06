//! TTS system types.

use serde::{Deserialize, Serialize};

/// Supported TTS providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TtsProvider {
    Elevenlabs,
    Openai,
    Edge,
    SimpleVoice,
    Auto,
}

impl std::fmt::Display for TtsProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Elevenlabs => write!(f, "elevenlabs"),
            Self::Openai => write!(f, "openai"),
            Self::Edge => write!(f, "edge"),
            Self::SimpleVoice => write!(f, "simple-voice"),
            Self::Auto => write!(f, "auto"),
        }
    }
}

/// When to automatically apply TTS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TtsAutoMode {
    Off,
    Always,
    Inbound,
    Tagged,
}

impl std::fmt::Display for TtsAutoMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => write!(f, "off"),
            Self::Always => write!(f, "always"),
            Self::Inbound => write!(f, "inbound"),
            Self::Tagged => write!(f, "tagged"),
        }
    }
}

/// Kind of application context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TtsApplyKind {
    Tool,
    Block,
    Final,
}

/// Audio format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TtsAudioFormat {
    Mp3,
    Opus,
    Wav,
}

impl Default for TtsAudioFormat {
    fn default() -> Self {
        Self::Mp3
    }
}

impl std::fmt::Display for TtsAudioFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mp3 => write!(f, "mp3"),
            Self::Opus => write!(f, "opus"),
            Self::Wav => write!(f, "wav"),
        }
    }
}

/// Full TTS configuration (defaults + session overrides merged).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsConfig {
    pub provider: TtsProvider,
    pub auto: TtsAutoMode,
    pub max_length: usize,
    pub summarize: bool,
    pub voice: Option<String>,
    pub model: Option<String>,
    pub speed: Option<f64>,
}

impl Default for TtsConfig {
    fn default() -> Self {
        DEFAULT_TTS_CONFIG.clone()
    }
}

/// Parsed `[[tts]]` directive options.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TtsDirective {
    pub provider: Option<TtsProvider>,
    pub voice: Option<String>,
    pub model: Option<String>,
    pub speed: Option<f64>,
    pub text: Option<String>,
}

/// Request for TTS synthesis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsRequest {
    pub text: String,
    pub provider: Option<TtsProvider>,
    pub voice: Option<String>,
    pub model: Option<String>,
    pub speed: Option<f64>,
    pub format: Option<TtsAudioFormat>,
}

/// Result of TTS synthesis.
#[derive(Debug, Clone)]
pub struct TtsSynthesisResult {
    pub audio: Vec<u8>,
    pub format: String,
    pub provider: TtsProvider,
    pub duration: Option<f64>,
}

/// Per-session TTS overrides (all optional).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TtsSessionConfig {
    pub auto: Option<TtsAutoMode>,
    pub provider: Option<TtsProvider>,
    pub voice: Option<String>,
    pub max_length: Option<usize>,
    pub summarize: Option<bool>,
}

/// Default TTS configuration.
pub const DEFAULT_TTS_CONFIG: TtsConfig = TtsConfig {
    provider: TtsProvider::Auto,
    auto: TtsAutoMode::Off,
    max_length: 1500,
    summarize: true,
    voice: None,
    model: None,
    speed: None,
};

/// Provider priority for auto-selection.
pub const TTS_PROVIDER_PRIORITY: &[TtsProvider] = &[
    TtsProvider::Elevenlabs,
    TtsProvider::Openai,
    TtsProvider::Edge,
    TtsProvider::SimpleVoice,
];

/// Get API key environment variable names for a provider.
pub fn tts_provider_api_keys(provider: TtsProvider) -> &'static [&'static str] {
    match provider {
        TtsProvider::Elevenlabs => &["ELEVENLABS_API_KEY", "XI_API_KEY"],
        TtsProvider::Openai => &["OPENAI_API_KEY"],
        TtsProvider::Edge => &[],
        TtsProvider::SimpleVoice => &[],
        TtsProvider::Auto => &[],
    }
}
