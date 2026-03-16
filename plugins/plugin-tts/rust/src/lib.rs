//! elizaOS TTS Plugin — text-to-speech coordinator with multi-provider support.
//!
//! Provides a unified TTS interface that:
//! - Supports multiple providers (ElevenLabs, OpenAI, Edge, Simple Voice)
//! - Auto-selects providers based on available API keys
//! - Parses `[[tts]]` directives from messages
//! - Handles text processing and length limits
//! - Manages per-session TTS configuration

#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

pub mod config;
pub mod directives;
pub mod error;
pub mod text_processor;
pub mod types;

// Re-exports — directives
pub use directives::{
    get_tts_text, has_tts_directive, normalize_provider, parse_json_voice_directive,
    parse_tts_directive, strip_tts_directives, JsonVoiceDirectiveResult,
};

// Re-exports — text processor
pub use text_processor::{clean_text_for_tts, truncate_text};

// Re-exports — config
pub use config::{
    clear_tts_config, get_tts_config, set_tts_config, should_apply_tts, ShouldApplyOptions,
};

// Re-exports — types
pub use types::{
    TtsApplyKind, TtsAudioFormat, TtsAutoMode, TtsConfig, TtsDirective, TtsProvider, TtsRequest,
    TtsSessionConfig, TtsSynthesisResult, DEFAULT_TTS_CONFIG, TTS_PROVIDER_PRIORITY,
};

// Re-exports — error
pub use error::{TtsError, TtsResult};

pub const PLUGIN_NAME: &str = "tts";
pub const PLUGIN_DESCRIPTION: &str =
    "Text-to-speech coordinator with multi-provider support and [[tts]] directives";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

// ============================================================================
// Trait definitions
// ============================================================================

/// Result of a provider query.
#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub values: Value,
    pub text: String,
    pub data: Value,
}

/// A provider that exposes information to the agent runtime.
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn position(&self) -> i32;
    async fn get(&self, message: &Value, state: &Value) -> ProviderResult;
}

// ============================================================================
// Provider availability helpers
// ============================================================================

/// Check if a provider is available (has required API keys).
///
/// `get_setting` should return the value of a setting key if present.
pub fn is_provider_available<F>(provider: TtsProvider, get_setting: F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    if provider == TtsProvider::Auto {
        return true;
    }

    let required_keys = types::tts_provider_api_keys(provider);
    if required_keys.is_empty() {
        return true;
    }

    required_keys.iter().any(|key| {
        if let Some(value) = get_setting(key) {
            !value.trim().is_empty()
        } else {
            false
        }
    })
}

/// Get the best available provider.
pub fn get_best_provider<F>(preferred: Option<TtsProvider>, get_setting: F) -> TtsProvider
where
    F: Fn(&str) -> Option<String>,
{
    if let Some(pref) = preferred {
        if pref != TtsProvider::Auto && is_provider_available(pref, &get_setting) {
            return pref;
        }
    }

    for &provider in TTS_PROVIDER_PRIORITY {
        if is_provider_available(provider, &get_setting) {
            return provider;
        }
    }

    TtsProvider::SimpleVoice
}

/// Format TTS configuration for display.
pub fn format_tts_config(config: &TtsConfig) -> String {
    let mut lines = vec![
        format!("Auto: {}", config.auto),
        format!("Provider: {}", config.provider),
        format!("Max length: {}", config.max_length),
        format!("Summarize: {}", if config.summarize { "yes" } else { "no" }),
    ];
    if let Some(ref voice) = config.voice {
        lines.push(format!("Voice: {}", voice));
    }
    lines.join("\n")
}

// ============================================================================
// Prelude
// ============================================================================

pub mod prelude {
    pub use crate::config::{
        clear_tts_config, get_tts_config, set_tts_config, should_apply_tts, ShouldApplyOptions,
    };
    pub use crate::directives::{
        get_tts_text, has_tts_directive, normalize_provider, parse_json_voice_directive,
        parse_tts_directive, strip_tts_directives,
    };
    pub use crate::error::{TtsError, TtsResult};
    pub use crate::text_processor::{clean_text_for_tts, truncate_text};
    pub use crate::types::{
        TtsApplyKind, TtsAudioFormat, TtsAutoMode, TtsConfig, TtsDirective, TtsProvider,
        TtsRequest, TtsSessionConfig, TtsSynthesisResult, DEFAULT_TTS_CONFIG,
        TTS_PROVIDER_PRIORITY,
    };
    pub use crate::{
        format_tts_config, get_best_provider, is_provider_available, Provider, ProviderResult,
        PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION,
    };
}
