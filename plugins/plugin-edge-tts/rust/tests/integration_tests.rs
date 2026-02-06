//! Integration tests for the Edge TTS plugin types and helpers.

use eliza_plugin_edge_tts::types::{escape_xml, infer_extension, resolve_voice, speed_to_rate};
use eliza_plugin_edge_tts::{
    EdgeTTSParams, EdgeTTSPlugin, EdgeTTSSettings, DEFAULT_LANG, DEFAULT_OUTPUT_FORMAT,
    DEFAULT_TIMEOUT_MS, DEFAULT_VOICE, POPULAR_VOICES, SUPPORTED_OUTPUT_FORMATS, VOICE_PRESETS,
};

// === Voice Resolution Tests ===

#[test]
fn test_resolve_voice_preset_alloy() {
    assert_eq!(
        resolve_voice(Some("alloy"), "default"),
        "en-US-GuyNeural"
    );
}

#[test]
fn test_resolve_voice_preset_echo() {
    assert_eq!(
        resolve_voice(Some("echo"), "default"),
        "en-US-ChristopherNeural"
    );
}

#[test]
fn test_resolve_voice_preset_fable() {
    assert_eq!(
        resolve_voice(Some("fable"), "default"),
        "en-GB-RyanNeural"
    );
}

#[test]
fn test_resolve_voice_preset_onyx() {
    assert_eq!(
        resolve_voice(Some("onyx"), "default"),
        "en-US-DavisNeural"
    );
}

#[test]
fn test_resolve_voice_preset_nova() {
    assert_eq!(
        resolve_voice(Some("nova"), "default"),
        "en-US-JennyNeural"
    );
}

#[test]
fn test_resolve_voice_preset_shimmer() {
    assert_eq!(
        resolve_voice(Some("shimmer"), "default"),
        "en-US-AriaNeural"
    );
}

#[test]
fn test_resolve_voice_case_insensitive() {
    assert_eq!(
        resolve_voice(Some("ALLOY"), "default"),
        "en-US-GuyNeural"
    );
    assert_eq!(
        resolve_voice(Some("Nova"), "default"),
        "en-US-JennyNeural"
    );
    assert_eq!(
        resolve_voice(Some("SHIMMER"), "default"),
        "en-US-AriaNeural"
    );
}

#[test]
fn test_resolve_voice_direct_id() {
    assert_eq!(
        resolve_voice(Some("en-US-MichelleNeural"), "default"),
        "en-US-MichelleNeural"
    );
    assert_eq!(
        resolve_voice(Some("de-DE-KatjaNeural"), "default"),
        "de-DE-KatjaNeural"
    );
}

#[test]
fn test_resolve_voice_none() {
    assert_eq!(
        resolve_voice(None, "en-US-MichelleNeural"),
        "en-US-MichelleNeural"
    );
}

#[test]
fn test_resolve_voice_empty() {
    assert_eq!(
        resolve_voice(Some(""), "en-US-MichelleNeural"),
        "en-US-MichelleNeural"
    );
}

// === Speed to Rate Conversion Tests ===

#[test]
fn test_speed_to_rate_normal() {
    assert_eq!(speed_to_rate(Some(1.0)), None);
}

#[test]
fn test_speed_to_rate_none() {
    assert_eq!(speed_to_rate(None), None);
}

#[test]
fn test_speed_to_rate_faster() {
    assert_eq!(speed_to_rate(Some(1.5)), Some("+50%".to_string()));
    assert_eq!(speed_to_rate(Some(2.0)), Some("+100%".to_string()));
}

#[test]
fn test_speed_to_rate_slower() {
    assert_eq!(speed_to_rate(Some(0.75)), Some("-25%".to_string()));
    assert_eq!(speed_to_rate(Some(0.5)), Some("-50%".to_string()));
}

#[test]
fn test_speed_to_rate_slight_change() {
    assert_eq!(speed_to_rate(Some(1.1)), Some("+10%".to_string()));
    assert_eq!(speed_to_rate(Some(0.9)), Some("-10%".to_string()));
}

// === Extension Inference Tests ===

#[test]
fn test_infer_extension_mp3() {
    assert_eq!(infer_extension("audio-24khz-48kbitrate-mono-mp3"), ".mp3");
}

#[test]
fn test_infer_extension_webm() {
    assert_eq!(infer_extension("webm-24khz-16bit-mono-opus"), ".webm");
}

#[test]
fn test_infer_extension_ogg() {
    assert_eq!(infer_extension("ogg-24khz-16bit-mono-opus"), ".ogg");
}

#[test]
fn test_infer_extension_wav() {
    assert_eq!(infer_extension("riff-24khz-16bit-mono-pcm"), ".wav");
}

#[test]
fn test_infer_extension_pcm() {
    assert_eq!(infer_extension("raw-24khz-16bit-mono-pcm"), ".wav");
}

#[test]
fn test_infer_extension_unknown() {
    assert_eq!(infer_extension("some-unknown-format"), ".mp3");
}

// === XML Escaping Tests ===

#[test]
fn test_escape_xml_ampersand() {
    assert_eq!(escape_xml("foo & bar"), "foo &amp; bar");
}

#[test]
fn test_escape_xml_angle_brackets() {
    assert_eq!(escape_xml("<hello>"), "&lt;hello&gt;");
}

#[test]
fn test_escape_xml_quotes() {
    assert_eq!(escape_xml("say \"hello\""), "say &quot;hello&quot;");
}

#[test]
fn test_escape_xml_apostrophe() {
    assert_eq!(escape_xml("it's"), "it&apos;s");
}

#[test]
fn test_escape_xml_no_special_chars() {
    assert_eq!(escape_xml("Hello world"), "Hello world");
}

// === Settings Tests ===

#[test]
fn test_settings_default() {
    let settings = EdgeTTSSettings::default();
    assert_eq!(settings.voice, DEFAULT_VOICE);
    assert_eq!(settings.lang, DEFAULT_LANG);
    assert_eq!(settings.output_format, DEFAULT_OUTPUT_FORMAT);
    assert_eq!(settings.timeout_ms, DEFAULT_TIMEOUT_MS);
    assert!(settings.rate.is_none());
    assert!(settings.pitch.is_none());
    assert!(settings.volume.is_none());
    assert!(settings.proxy.is_none());
}

#[test]
fn test_settings_custom() {
    let settings = EdgeTTSSettings {
        voice: "en-US-GuyNeural".to_string(),
        lang: "en-US".to_string(),
        output_format: "audio-48khz-96kbitrate-mono-mp3".to_string(),
        rate: Some("+10%".to_string()),
        pitch: Some("+5Hz".to_string()),
        volume: Some("+20%".to_string()),
        proxy: None,
        timeout_ms: 15000,
    };
    assert_eq!(settings.voice, "en-US-GuyNeural");
    assert_eq!(settings.rate.as_deref(), Some("+10%"));
    assert_eq!(settings.pitch.as_deref(), Some("+5Hz"));
    assert_eq!(settings.volume.as_deref(), Some("+20%"));
    assert_eq!(settings.timeout_ms, 15000);
}

// === Params Tests ===

#[test]
fn test_params_default() {
    let params = EdgeTTSParams::default();
    assert!(params.text.is_empty());
    assert!(params.voice.is_none());
    assert!(params.speed.is_none());
    assert!(params.lang.is_none());
    assert!(params.rate.is_none());
    assert!(params.pitch.is_none());
    assert!(params.volume.is_none());
}

#[test]
fn test_params_custom() {
    let params = EdgeTTSParams {
        text: "Hello world".to_string(),
        voice: Some("alloy".to_string()),
        speed: Some(1.5),
        lang: Some("en-US".to_string()),
        output_format: None,
        rate: None,
        pitch: Some("+5Hz".to_string()),
        volume: None,
    };
    assert_eq!(params.text, "Hello world");
    assert_eq!(params.voice.as_deref(), Some("alloy"));
    assert_eq!(params.speed, Some(1.5));
}

// === Plugin Tests ===

#[test]
fn test_plugin_default() {
    let plugin = EdgeTTSPlugin::new();
    assert_eq!(plugin.name, "edge-tts");
    assert!(plugin.description.contains("text-to-speech"));
    assert!(plugin.description.contains("no API key"));
}

#[test]
fn test_plugin_with_settings() {
    let settings = EdgeTTSSettings {
        voice: "en-GB-RyanNeural".to_string(),
        ..Default::default()
    };
    let plugin = EdgeTTSPlugin::with_settings(settings);
    assert_eq!(plugin.settings.voice, "en-GB-RyanNeural");
    assert_eq!(plugin.name, "edge-tts");
}

// === Constants Tests ===

#[test]
fn test_voice_presets_count() {
    assert_eq!(VOICE_PRESETS.len(), 6);
}

#[test]
fn test_supported_output_formats_not_empty() {
    assert!(!SUPPORTED_OUTPUT_FORMATS.is_empty());
}

#[test]
fn test_popular_voices_not_empty() {
    assert!(!POPULAR_VOICES.is_empty());
    assert!(POPULAR_VOICES.contains(&"en-US-MichelleNeural"));
}

#[test]
fn test_version() {
    assert!(!eliza_plugin_edge_tts::VERSION.is_empty());
}
