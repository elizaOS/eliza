//! TTS directive parser.
//!
//! Parses `[[tts]]` directives from text:
//! - `[[tts]]` — simple marker to enable TTS
//! - `[[tts:provider=elevenlabs]]` — specify provider
//! - `[[tts:voice=alloy]]` — specify voice
//! - `[[tts:text]]...[[/tts:text]]` — specify exact text to synthesize

use once_cell::sync::Lazy;
use regex::Regex;

use crate::types::{TtsDirective, TtsProvider};

// ---------------------------------------------------------------------------
// Compiled regex patterns
// ---------------------------------------------------------------------------

static TTS_DIRECTIVE_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\[\[tts(?::([^\]]+))?\]\]").unwrap());

static TTS_TEXT_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?is)\[\[tts:text\]\]([\s\S]*?)\[\[/tts:text\]\]").unwrap());

static KEY_VALUE_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\w+)\s*=\s*([^\s,]+)").unwrap());

// ---------------------------------------------------------------------------
// Provider normalisation
// ---------------------------------------------------------------------------

/// Normalize a raw provider string into a [`TtsProvider`].
pub fn normalize_provider(raw: &str) -> Option<TtsProvider> {
    match raw.to_lowercase().trim() {
        "elevenlabs" | "eleven" | "xi" => Some(TtsProvider::Elevenlabs),
        "openai" | "oai" => Some(TtsProvider::Openai),
        "edge" | "microsoft" | "ms" => Some(TtsProvider::Edge),
        "simple" | "simple-voice" | "sam" => Some(TtsProvider::SimpleVoice),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Check if text contains any TTS directive.
pub fn has_tts_directive(text: &str) -> bool {
    TTS_DIRECTIVE_PATTERN.is_match(text) || TTS_TEXT_PATTERN.is_match(text)
}

/// Parse TTS directives from text.
///
/// Returns a [`TtsDirective`] populated with whatever options were found,
/// or `None` if no directive is present.
pub fn parse_tts_directive(text: &str) -> Option<TtsDirective> {
    if !has_tts_directive(text) {
        return None;
    }

    let mut directive = TtsDirective::default();

    // Extract [[tts:text]]...[[/tts:text]] content
    if let Some(cap) = TTS_TEXT_PATTERN.captures(text) {
        let full_match = cap.get(0).unwrap().as_str();
        if let Some(content_start) = full_match.find("]]") {
            let after = &full_match[content_start + 2..];
            if let Some(content_end) = after.rfind("[[") {
                directive.text = Some(after[..content_end].trim().to_string());
            }
        }
    }

    // Parse [[tts:key=value]] directives
    for cap in TTS_DIRECTIVE_PATTERN.captures_iter(text) {
        if let Some(params) = cap.get(1) {
            let params_str = params.as_str();
            for kv in KEY_VALUE_PATTERN.captures_iter(params_str) {
                let key = kv[1].to_lowercase();
                let value = &kv[2];

                match key.as_str() {
                    "provider" => directive.provider = normalize_provider(value),
                    "voice" => directive.voice = Some(value.to_string()),
                    "model" => directive.model = Some(value.to_string()),
                    "speed" => directive.speed = value.parse::<f64>().ok(),
                    _ => {}
                }
            }
        }
    }

    Some(directive)
}

/// Result of parsing a JSON voice directive.
#[derive(Debug, Clone)]
pub struct JsonVoiceDirectiveResult {
    pub directive: TtsDirective,
    pub cleaned_text: String,
}

/// Parse a JSON voice directive from the first line of the reply.
///
/// Supports the openclaw-classic format:
/// ```text
/// { "voice": "abc123", "once": true }
/// Actual reply text here...
/// ```
///
/// Supported keys: voice/voice_id/voiceId, model/model_id/modelId, speed, rate.
pub fn parse_json_voice_directive(text: &str) -> Option<JsonVoiceDirectiveResult> {
    let first_newline = text.find('\n')?;
    let first_line = text[..first_newline].trim();

    if !first_line.starts_with('{') || !first_line.ends_with('}') {
        return None;
    }

    let obj: serde_json::Value = serde_json::from_str(first_line).ok()?;
    let obj = obj.as_object()?;

    // Must have at least one voice-related key
    let voice_keys = [
        "voice", "voice_id", "voiceId", "model", "model_id", "modelId", "speed", "rate",
    ];
    if !voice_keys.iter().any(|k| obj.contains_key(*k)) {
        return None;
    }

    let mut directive = TtsDirective::default();

    let voice = obj
        .get("voice")
        .or_else(|| obj.get("voice_id"))
        .or_else(|| obj.get("voiceId"));
    if let Some(v) = voice.and_then(|v| v.as_str()) {
        directive.voice = Some(v.to_string());
    }

    let model = obj
        .get("model")
        .or_else(|| obj.get("model_id"))
        .or_else(|| obj.get("modelId"));
    if let Some(m) = model.and_then(|m| m.as_str()) {
        directive.model = Some(m.to_string());
    }

    let speed = obj
        .get("speed")
        .and_then(|s| s.as_f64())
        .or_else(|| obj.get("rate").and_then(|r| r.as_f64()));
    if let Some(s) = speed {
        directive.speed = Some(s);
    }

    let cleaned_text = text[first_newline + 1..].trim().to_string();

    Some(JsonVoiceDirectiveResult {
        directive,
        cleaned_text,
    })
}

/// Strip all TTS directives from text, returning clean text.
pub fn strip_tts_directives(text: &str) -> String {
    let mut cleaned = text.to_string();

    // Remove [[tts:text]]...[[/tts:text]] blocks
    cleaned = TTS_TEXT_PATTERN.replace_all(&cleaned, "").to_string();

    // Remove [[tts:...]] directives
    cleaned = TTS_DIRECTIVE_PATTERN.replace_all(&cleaned, "").to_string();

    // Clean up extra whitespace
    let ws = Regex::new(r"\s+").unwrap();
    cleaned = ws.replace_all(&cleaned, " ").trim().to_string();

    cleaned
}

/// Get the text to synthesize from a message.
///
/// If the directive contains explicit text, returns that.
/// Otherwise returns the message with directives stripped.
pub fn get_tts_text(text: &str, directive: Option<&TtsDirective>) -> String {
    if let Some(d) = directive {
        if let Some(ref t) = d.text {
            return t.clone();
        }
    }
    strip_tts_directives(text)
}

// ===========================================================================
// Unit tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_has_tts_directive() {
        assert!(has_tts_directive("Hello [[tts]] world"));
        assert!(has_tts_directive("[[tts:provider=elevenlabs]] Hello"));
        assert!(has_tts_directive("[[tts:text]]Hello[[/tts:text]]"));
        assert!(!has_tts_directive("No directive here"));
        assert!(!has_tts_directive("[[not-tts]]"));
        assert!(!has_tts_directive("[tts]"));
    }

    #[test]
    fn test_parse_returns_none_for_plain_text() {
        assert!(parse_tts_directive("Plain text").is_none());
    }

    #[test]
    fn test_parse_simple_directive() {
        let d = parse_tts_directive("[[tts]] Hello");
        assert!(d.is_some());
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
        let d =
            parse_tts_directive("[[tts:provider=openai voice=nova speed=1.2]]").unwrap();
        assert_eq!(d.provider, Some(TtsProvider::Openai));
        assert_eq!(d.voice.as_deref(), Some("nova"));
        assert_eq!(d.speed, Some(1.2));
    }

    #[test]
    fn test_parse_text_block() {
        let d = parse_tts_directive("Before [[tts:text]]Custom TTS text[[/tts:text]] after")
            .unwrap();
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
    fn test_strip_directives() {
        assert_eq!(strip_tts_directives("Hello [[tts]] world"), "Hello world");
        assert_eq!(
            strip_tts_directives("[[tts:provider=elevenlabs]] Hello"),
            "Hello"
        );
        assert_eq!(
            strip_tts_directives("Before [[tts:text]]TTS text[[/tts:text]] after"),
            "Before after"
        );
        assert_eq!(
            strip_tts_directives("[[tts]] Hello [[tts:voice=alloy]] world"),
            "Hello world"
        );
    }

    #[test]
    fn test_get_tts_text_with_directive_text() {
        let text = "Message [[tts:text]]Custom[[/tts:text]]";
        let directive = parse_tts_directive(text);
        assert_eq!(get_tts_text(text, directive.as_ref()), "Custom");
    }

    #[test]
    fn test_get_tts_text_without_directive_text() {
        let text = "[[tts]] Message";
        let directive = parse_tts_directive(text);
        assert_eq!(get_tts_text(text, directive.as_ref()), "Message");
    }

    #[test]
    fn test_get_tts_text_no_directive() {
        assert_eq!(get_tts_text("Plain message", None), "Plain message");
    }

    #[test]
    fn test_json_voice_directive_no_newline() {
        assert!(parse_json_voice_directive("No newline").is_none());
    }

    #[test]
    fn test_json_voice_directive_non_json() {
        assert!(parse_json_voice_directive("Not JSON\nSecond line").is_none());
    }

    #[test]
    fn test_json_voice_directive_no_voice_keys() {
        assert!(parse_json_voice_directive("{\"unrelated\": true}\nText").is_none());
    }

    #[test]
    fn test_json_voice_directive_parses_voice() {
        let result = parse_json_voice_directive("{\"voice\": \"abc123\"}\nHello world").unwrap();
        assert_eq!(result.directive.voice.as_deref(), Some("abc123"));
        assert_eq!(result.cleaned_text, "Hello world");
    }

    #[test]
    fn test_json_voice_directive_parses_speed() {
        let result = parse_json_voice_directive("{\"speed\": 1.5}\nHello").unwrap();
        assert_eq!(result.directive.speed, Some(1.5));
    }

    #[test]
    fn test_json_voice_directive_parses_rate() {
        let result = parse_json_voice_directive("{\"rate\": 0.8}\nHello").unwrap();
        assert_eq!(result.directive.speed, Some(0.8));
    }
}
