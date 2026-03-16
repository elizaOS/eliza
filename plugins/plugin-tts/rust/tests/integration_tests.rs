//! Integration tests for the TTS plugin — mirrors TypeScript test coverage.

use elizaos_plugin_tts::prelude::*;

// ===========================================================================
// Directive tests
// ===========================================================================

#[test]
fn test_has_tts_directive_detects_simple() {
    assert!(has_tts_directive("Hello [[tts]] world"));
}

#[test]
fn test_has_tts_directive_detects_with_options() {
    assert!(has_tts_directive("[[tts:provider=elevenlabs]] Hello"));
}

#[test]
fn test_has_tts_directive_detects_text_blocks() {
    assert!(has_tts_directive("[[tts:text]]Hello[[/tts:text]]"));
}

#[test]
fn test_has_tts_directive_returns_false_for_plain_text() {
    assert!(!has_tts_directive("No directive here"));
}

#[test]
fn test_has_tts_directive_returns_false_for_invalid_patterns() {
    assert!(!has_tts_directive("[[not-tts]]"));
    assert!(!has_tts_directive("[tts]"));
}

#[test]
fn test_parse_returns_none_for_plain_text() {
    assert!(parse_tts_directive("Plain text").is_none());
}

#[test]
fn test_parse_simple_directive() {
    assert!(parse_tts_directive("[[tts]] Hello").is_some());
}

#[test]
fn test_parse_provider() {
    let d = parse_tts_directive("[[tts:provider=elevenlabs]]").unwrap();
    assert_eq!(d.provider, Some(TtsProvider::Elevenlabs));
}

#[test]
fn test_parse_voice() {
    let d = parse_tts_directive("[[tts:voice=alloy]]").unwrap();
    assert_eq!(d.voice.as_deref(), Some("alloy"));
}

#[test]
fn test_parse_speed() {
    let d = parse_tts_directive("[[tts:speed=1.5]]").unwrap();
    assert_eq!(d.speed, Some(1.5));
}

#[test]
fn test_parse_multiple_options() {
    let d = parse_tts_directive("[[tts:provider=openai voice=nova speed=1.2]]").unwrap();
    assert_eq!(d.provider, Some(TtsProvider::Openai));
    assert_eq!(d.voice.as_deref(), Some("nova"));
    assert_eq!(d.speed, Some(1.2));
}

#[test]
fn test_parse_text_block() {
    let d = parse_tts_directive("Before [[tts:text]]Custom TTS text[[/tts:text]] after").unwrap();
    assert_eq!(d.text.as_deref(), Some("Custom TTS text"));
}

#[test]
fn test_normalize_provider_names() {
    assert_eq!(
        parse_tts_directive("[[tts:provider=eleven]]")
            .unwrap()
            .provider,
        Some(TtsProvider::Elevenlabs)
    );
    assert_eq!(
        parse_tts_directive("[[tts:provider=oai]]")
            .unwrap()
            .provider,
        Some(TtsProvider::Openai)
    );
    assert_eq!(
        parse_tts_directive("[[tts:provider=microsoft]]")
            .unwrap()
            .provider,
        Some(TtsProvider::Edge)
    );
    assert_eq!(
        parse_tts_directive("[[tts:provider=sam]]")
            .unwrap()
            .provider,
        Some(TtsProvider::SimpleVoice)
    );
}

#[test]
fn test_strip_simple_directive() {
    assert_eq!(strip_tts_directives("Hello [[tts]] world"), "Hello world");
}

#[test]
fn test_strip_directive_with_options() {
    assert_eq!(
        strip_tts_directives("[[tts:provider=elevenlabs]] Hello"),
        "Hello"
    );
}

#[test]
fn test_strip_text_blocks() {
    assert_eq!(
        strip_tts_directives("Before [[tts:text]]TTS text[[/tts:text]] after"),
        "Before after"
    );
}

#[test]
fn test_strip_multiple_directives() {
    assert_eq!(
        strip_tts_directives("[[tts]] Hello [[tts:voice=alloy]] world"),
        "Hello world"
    );
}

#[test]
fn test_get_tts_text_directive_text() {
    let text = "Message [[tts:text]]Custom[[/tts:text]]";
    let directive = parse_tts_directive(text);
    assert_eq!(get_tts_text(text, directive.as_ref()), "Custom");
}

#[test]
fn test_get_tts_text_no_directive_text() {
    let text = "[[tts]] Message";
    let directive = parse_tts_directive(text);
    assert_eq!(get_tts_text(text, directive.as_ref()), "Message");
}

#[test]
fn test_get_tts_text_no_directive() {
    assert_eq!(get_tts_text("Plain message", None), "Plain message");
}

// ===========================================================================
// JSON voice directive tests
// ===========================================================================

#[test]
fn test_json_no_newline() {
    assert!(parse_json_voice_directive("No newline").is_none());
}

#[test]
fn test_json_non_json_first_line() {
    assert!(parse_json_voice_directive("Not JSON\nSecond line").is_none());
}

#[test]
fn test_json_no_voice_keys() {
    assert!(parse_json_voice_directive("{\"unrelated\": true}\nText").is_none());
}

#[test]
fn test_json_parses_voice() {
    let result = parse_json_voice_directive("{\"voice\": \"abc123\"}\nHello world").unwrap();
    assert_eq!(result.directive.voice.as_deref(), Some("abc123"));
    assert_eq!(result.cleaned_text, "Hello world");
}

#[test]
fn test_json_parses_speed() {
    let result = parse_json_voice_directive("{\"speed\": 1.5}\nHello").unwrap();
    assert_eq!(result.directive.speed, Some(1.5));
}

#[test]
fn test_json_parses_rate() {
    let result = parse_json_voice_directive("{\"rate\": 0.8}\nHello").unwrap();
    assert_eq!(result.directive.speed, Some(0.8));
}

// ===========================================================================
// Text processor tests
// ===========================================================================

#[test]
fn test_clean_removes_code_blocks() {
    let text = "Hello\n```js\ncode\n```\nworld";
    assert_eq!(clean_text_for_tts(text), "Hello\n[code block]\nworld");
}

#[test]
fn test_clean_removes_inline_code() {
    assert_eq!(clean_text_for_tts("Use `const` here"), "Use [code] here");
}

#[test]
fn test_clean_removes_urls() {
    assert_eq!(
        clean_text_for_tts("Visit https://example.com now"),
        "Visit [link] now"
    );
}

#[test]
fn test_clean_removes_bold() {
    assert_eq!(
        clean_text_for_tts("This is **bold** text"),
        "This is bold text"
    );
}

#[test]
fn test_clean_removes_italic() {
    assert_eq!(
        clean_text_for_tts("This is *italic* text"),
        "This is italic text"
    );
}

#[test]
fn test_clean_removes_headers() {
    assert_eq!(clean_text_for_tts("# Header\nText"), "Header\nText");
}

#[test]
fn test_clean_removes_links() {
    assert_eq!(
        clean_text_for_tts("[click here](https://example.com)"),
        "click here"
    );
}

#[test]
fn test_clean_removes_html() {
    assert_eq!(clean_text_for_tts("<b>bold</b> text"), "bold text");
}

#[test]
fn test_clean_combined() {
    let text = "**Bold** and `code` with https://example.com";
    assert_eq!(clean_text_for_tts(text), "Bold and [code] with [link]");
}

#[test]
fn test_truncate_under_limit() {
    assert_eq!(truncate_text("Short text", 100), "Short text");
}

#[test]
fn test_truncate_at_sentence_boundary() {
    let text = "First sentence. Second sentence. Third sentence.";
    let truncated = truncate_text(text, 20);
    assert_eq!(truncated, "First sentence.");
}

#[test]
fn test_truncate_adds_ellipsis() {
    let text = "This is a very long sentence without any breaks";
    let truncated = truncate_text(text, 20);
    assert!(truncated.ends_with("..."));
    assert!(truncated.len() <= 23);
}

#[test]
fn test_truncate_at_word_boundary() {
    let text = "Word1 Word2 Word3 Word4 Word5";
    let truncated = truncate_text(text, 15);
    assert!(!truncated.contains("Word3"));
}

// ===========================================================================
// Config tests
// ===========================================================================

#[test]
fn test_default_config_for_new_room() {
    let room = "integration-test-default";
    clear_tts_config(room);
    let config = get_tts_config(room);
    assert_eq!(config.auto, TtsAutoMode::Off);
    assert_eq!(config.provider, TtsProvider::Auto);
}

#[test]
fn test_set_and_get_config() {
    let room = "integration-test-set";
    clear_tts_config(room);

    set_tts_config(
        room,
        TtsSessionConfig {
            auto: Some(TtsAutoMode::Always),
            provider: Some(TtsProvider::Edge),
            ..Default::default()
        },
    );

    let config = get_tts_config(room);
    assert_eq!(config.auto, TtsAutoMode::Always);
    assert_eq!(config.provider, TtsProvider::Edge);
    clear_tts_config(room);
}

#[test]
fn test_merge_config() {
    let room = "integration-test-merge";
    clear_tts_config(room);

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
    assert_eq!(config.auto, TtsAutoMode::Always);
    assert_eq!(config.provider, TtsProvider::Openai);
    clear_tts_config(room);
}

#[test]
fn test_clear_config_restores_defaults() {
    let room = "integration-test-clear";
    clear_tts_config(room);

    set_tts_config(
        room,
        TtsSessionConfig {
            auto: Some(TtsAutoMode::Always),
            ..Default::default()
        },
    );
    clear_tts_config(room);

    let config = get_tts_config(room);
    assert_eq!(config.auto, TtsAutoMode::Off);
}

// ===========================================================================
// shouldApplyTts tests
// ===========================================================================

#[test]
fn test_should_apply_off() {
    let config = TtsConfig {
        auto: TtsAutoMode::Off,
        ..Default::default()
    };
    assert!(!should_apply_tts(&config, &ShouldApplyOptions::default()));
}

#[test]
fn test_should_apply_always() {
    let config = TtsConfig {
        auto: TtsAutoMode::Always,
        ..Default::default()
    };
    assert!(should_apply_tts(&config, &ShouldApplyOptions::default()));
}

#[test]
fn test_should_apply_inbound() {
    let config = TtsConfig {
        auto: TtsAutoMode::Inbound,
        ..Default::default()
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
        ..Default::default()
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

// ===========================================================================
// Provider availability tests
// ===========================================================================

#[test]
fn test_is_provider_available_auto() {
    assert!(elizaos_plugin_tts::is_provider_available(
        TtsProvider::Auto,
        |_| None
    ));
}

#[test]
fn test_is_provider_available_no_key_required() {
    assert!(elizaos_plugin_tts::is_provider_available(
        TtsProvider::Edge,
        |_| None
    ));
    assert!(elizaos_plugin_tts::is_provider_available(
        TtsProvider::SimpleVoice,
        |_| None
    ));
}

#[test]
fn test_is_provider_available_with_key() {
    assert!(elizaos_plugin_tts::is_provider_available(
        TtsProvider::Openai,
        |key| {
            if key == "OPENAI_API_KEY" {
                Some("sk-test".to_string())
            } else {
                None
            }
        }
    ));
}

#[test]
fn test_is_provider_unavailable_without_key() {
    assert!(!elizaos_plugin_tts::is_provider_available(
        TtsProvider::Openai,
        |_| None
    ));
}

#[test]
fn test_get_best_provider_preferred() {
    let provider = elizaos_plugin_tts::get_best_provider(Some(TtsProvider::Edge), |_| None);
    assert_eq!(provider, TtsProvider::Edge);
}

#[test]
fn test_get_best_provider_fallback() {
    let provider = elizaos_plugin_tts::get_best_provider(
        Some(TtsProvider::Openai),
        |_| None, // No keys available
    );
    // Should fall through to edge (no key required) in priority order
    assert_eq!(provider, TtsProvider::Edge);
}

#[test]
fn test_format_tts_config() {
    let config = TtsConfig {
        auto: TtsAutoMode::Always,
        provider: TtsProvider::Openai,
        max_length: 2000,
        summarize: false,
        voice: Some("nova".to_string()),
        ..Default::default()
    };
    let formatted = elizaos_plugin_tts::format_tts_config(&config);
    assert!(formatted.contains("Auto: always"));
    assert!(formatted.contains("Provider: openai"));
    assert!(formatted.contains("Max length: 2000"));
    assert!(formatted.contains("Summarize: no"));
    assert!(formatted.contains("Voice: nova"));
}
