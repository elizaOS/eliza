//! TTS configuration management.
//!
//! Maintains per-session TTS settings that override defaults.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::types::{
    TtsApplyKind, TtsAutoMode, TtsConfig, TtsSessionConfig, DEFAULT_TTS_CONFIG,
};

// ---------------------------------------------------------------------------
// Session config store (in-memory, keyed by room / session ID)
// ---------------------------------------------------------------------------

static SESSION_CONFIGS: Lazy<Mutex<HashMap<String, TtsSessionConfig>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Get the merged TTS configuration for a room.
///
/// Returns defaults merged with any per-session overrides.
pub fn get_tts_config(room_id: &str) -> TtsConfig {
    let configs = SESSION_CONFIGS.lock().unwrap();
    let session = configs.get(room_id);

    let mut config = DEFAULT_TTS_CONFIG.clone();

    if let Some(s) = session {
        if let Some(auto) = s.auto {
            config.auto = auto;
        }
        if let Some(provider) = s.provider {
            config.provider = provider;
        }
        if let Some(ref voice) = s.voice {
            config.voice = Some(voice.clone());
        }
        if let Some(max_length) = s.max_length {
            config.max_length = max_length;
        }
        if let Some(summarize) = s.summarize {
            config.summarize = summarize;
        }
    }

    config
}

/// Set (merge) TTS configuration for a room.
pub fn set_tts_config(room_id: &str, config: TtsSessionConfig) {
    let mut configs = SESSION_CONFIGS.lock().unwrap();
    let existing = configs.entry(room_id.to_string()).or_default();

    if let Some(auto) = config.auto {
        existing.auto = Some(auto);
    }
    if let Some(provider) = config.provider {
        existing.provider = Some(provider);
    }
    if config.voice.is_some() {
        existing.voice = config.voice;
    }
    if let Some(max_length) = config.max_length {
        existing.max_length = Some(max_length);
    }
    if let Some(summarize) = config.summarize {
        existing.summarize = Some(summarize);
    }
}

/// Clear all TTS configuration for a room.
pub fn clear_tts_config(room_id: &str) {
    let mut configs = SESSION_CONFIGS.lock().unwrap();
    configs.remove(room_id);
}

/// Options for determining whether TTS should be applied.
#[derive(Debug, Default)]
pub struct ShouldApplyOptions {
    pub inbound_audio: bool,
    pub kind: Option<TtsApplyKind>,
    pub has_directive: bool,
}

/// Determine whether TTS should be applied given config and context.
///
/// Modes:
/// - `off`      — never apply
/// - `always`   — always apply
/// - `inbound`  — only when the inbound message had audio
/// - `tagged`   — only when a `[[tts]]` directive is present
pub fn should_apply_tts(config: &TtsConfig, options: &ShouldApplyOptions) -> bool {
    match config.auto {
        TtsAutoMode::Off => false,
        TtsAutoMode::Always => true,
        TtsAutoMode::Inbound => options.inbound_audio,
        TtsAutoMode::Tagged => options.has_directive,
    }
}

// ===========================================================================
// Unit tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TtsProvider;

    fn clean_room(room_id: &str) {
        clear_tts_config(room_id);
    }

    #[test]
    fn test_returns_default_config_for_new_room() {
        let room = "test-room-default";
        clean_room(room);
        let config = get_tts_config(room);
        assert_eq!(config.auto, DEFAULT_TTS_CONFIG.auto);
        assert_eq!(config.provider, DEFAULT_TTS_CONFIG.provider);
    }

    #[test]
    fn test_returns_merged_config() {
        let room = "test-room-merged";
        clean_room(room);

        set_tts_config(
            room,
            TtsSessionConfig {
                auto: Some(TtsAutoMode::Always),
                ..Default::default()
            },
        );
        let config = get_tts_config(room);
        assert_eq!(config.auto, TtsAutoMode::Always);
        assert_eq!(config.provider, DEFAULT_TTS_CONFIG.provider); // default preserved
        clean_room(room);
    }

    #[test]
    fn test_sets_config_values() {
        let room = "test-room-set";
        clean_room(room);

        set_tts_config(
            room,
            TtsSessionConfig {
                auto: Some(TtsAutoMode::Inbound),
                provider: Some(TtsProvider::Edge),
                ..Default::default()
            },
        );
        let config = get_tts_config(room);
        assert_eq!(config.auto, TtsAutoMode::Inbound);
        assert_eq!(config.provider, TtsProvider::Edge);
        clean_room(room);
    }

    #[test]
    fn test_merges_with_existing() {
        let room = "test-room-merge-existing";
        clean_room(room);

        set_tts_config(
            room,
            TtsSessionConfig {
                auto: Some(TtsAutoMode::Always),
                ..Default::default()
            },
        );
        set_tts_config(
            room,
            TtsSessionConfig {
                provider: Some(TtsProvider::Openai),
                ..Default::default()
            },
        );

        let config = get_tts_config(room);
        assert_eq!(config.auto, TtsAutoMode::Always); // preserved
        assert_eq!(config.provider, TtsProvider::Openai); // updated
        clean_room(room);
    }

    #[test]
    fn test_clear_config() {
        let room = "test-room-clear";
        clean_room(room);

        set_tts_config(
            room,
            TtsSessionConfig {
                auto: Some(TtsAutoMode::Always),
                ..Default::default()
            },
        );
        clear_tts_config(room);
        let config = get_tts_config(room);
        assert_eq!(config.auto, DEFAULT_TTS_CONFIG.auto); // back to default
    }

    #[test]
    fn test_should_apply_off() {
        let config = TtsConfig {
            auto: TtsAutoMode::Off,
            ..DEFAULT_TTS_CONFIG.clone()
        };
        assert!(!should_apply_tts(&config, &ShouldApplyOptions::default()));
    }

    #[test]
    fn test_should_apply_always() {
        let config = TtsConfig {
            auto: TtsAutoMode::Always,
            ..DEFAULT_TTS_CONFIG.clone()
        };
        assert!(should_apply_tts(&config, &ShouldApplyOptions::default()));
    }

    #[test]
    fn test_should_apply_inbound() {
        let config = TtsConfig {
            auto: TtsAutoMode::Inbound,
            ..DEFAULT_TTS_CONFIG.clone()
        };
        assert!(!should_apply_tts(&config, &ShouldApplyOptions::default()));
        assert!(!should_apply_tts(
            &config,
            &ShouldApplyOptions {
                inbound_audio: false,
                ..Default::default()
            }
        ));
        assert!(should_apply_tts(
            &config,
            &ShouldApplyOptions {
                inbound_audio: true,
                ..Default::default()
            }
        ));
    }

    #[test]
    fn test_should_apply_tagged() {
        let config = TtsConfig {
            auto: TtsAutoMode::Tagged,
            ..DEFAULT_TTS_CONFIG.clone()
        };
        assert!(!should_apply_tts(&config, &ShouldApplyOptions::default()));
        assert!(!should_apply_tts(
            &config,
            &ShouldApplyOptions {
                has_directive: false,
                ..Default::default()
            }
        ));
        assert!(should_apply_tts(
            &config,
            &ShouldApplyOptions {
                has_directive: true,
                ..Default::default()
            }
        ));
    }
}
