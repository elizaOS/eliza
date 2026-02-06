//! Text processor for TTS.
//!
//! Handles text cleaning, length limits, and truncation for speech synthesis.

use once_cell::sync::Lazy;
use regex::Regex;

// ---------------------------------------------------------------------------
// Compiled regex patterns
// ---------------------------------------------------------------------------

static RE_CODE_BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)```[\s\S]*?```").unwrap());
static RE_INLINE_CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"`[^`]+`").unwrap());
static RE_URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"https?://[^\s]+").unwrap());
static RE_BOLD_STAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*\*([^*]+)\*\*").unwrap());
static RE_ITALIC_STAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*([^*]+)\*").unwrap());
static RE_BOLD_UNDER: Lazy<Regex> = Lazy::new(|| Regex::new(r"__([^_]+)__").unwrap());
static RE_ITALIC_UNDER: Lazy<Regex> = Lazy::new(|| Regex::new(r"_([^_]+)_").unwrap());
static RE_HEADER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^#{1,6}\s+").unwrap());
static RE_LINK: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());
static RE_HTML: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static RE_MULTI_NEWLINE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{2,}").unwrap());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Clean text for TTS synthesis.
///
/// Removes markdown, code blocks, URLs, and other non-speech content.
pub fn clean_text_for_tts(text: &str) -> String {
    let mut cleaned = text.to_string();

    // Remove code blocks
    cleaned = RE_CODE_BLOCK.replace_all(&cleaned, "[code block]").to_string();

    // Remove inline code
    cleaned = RE_INLINE_CODE.replace_all(&cleaned, "[code]").to_string();

    // Remove markdown links but keep text (must come before URL removal)
    cleaned = RE_LINK.replace_all(&cleaned, "$1").to_string();

    // Remove URLs
    cleaned = RE_URL.replace_all(&cleaned, "[link]").to_string();

    // Remove markdown bold/italic
    cleaned = RE_BOLD_STAR.replace_all(&cleaned, "$1").to_string();
    cleaned = RE_ITALIC_STAR.replace_all(&cleaned, "$1").to_string();
    cleaned = RE_BOLD_UNDER.replace_all(&cleaned, "$1").to_string();
    cleaned = RE_ITALIC_UNDER.replace_all(&cleaned, "$1").to_string();

    // Remove markdown headers
    cleaned = RE_HEADER.replace_all(&cleaned, "").to_string();

    // Remove HTML tags
    cleaned = RE_HTML.replace_all(&cleaned, "").to_string();

    // Convert multiple newlines to single
    cleaned = RE_MULTI_NEWLINE.replace_all(&cleaned, "\n").to_string();

    // Remove leading/trailing whitespace
    cleaned.trim().to_string()
}

/// Truncate text to `max_length`, trying to break at sentence boundaries.
pub fn truncate_text(text: &str, max_length: usize) -> String {
    if text.len() <= max_length {
        return text.to_string();
    }

    // Try to break at sentence boundary
    let truncated = &text[..max_length];

    let sentence_ends = [
        truncated.rfind(". "),
        truncated.rfind("! "),
        truncated.rfind("? "),
        truncated.rfind(".\n"),
        truncated.rfind("!\n"),
        truncated.rfind("?\n"),
    ];

    let last_sentence_end = sentence_ends.iter().filter_map(|&x| x).max();

    if let Some(pos) = last_sentence_end {
        let threshold = (max_length as f64 * 0.5) as usize;
        if pos > threshold {
            return truncated[..pos + 1].trim().to_string();
        }
    }

    // Fall back to word boundary
    if let Some(last_space) = truncated.rfind(' ') {
        let threshold = (max_length as f64 * 0.8) as usize;
        if last_space > threshold {
            return format!("{}...", truncated[..last_space].trim());
        }
    }

    format!("{}...", truncated.trim())
}

// ===========================================================================
// Unit tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_removes_code_blocks() {
        let text = "Hello\n```js\ncode\n```\nworld";
        assert_eq!(clean_text_for_tts(text), "Hello\n[code block]\nworld");
    }

    #[test]
    fn test_removes_inline_code() {
        assert_eq!(clean_text_for_tts("Use `const` here"), "Use [code] here");
    }

    #[test]
    fn test_removes_urls() {
        assert_eq!(
            clean_text_for_tts("Visit https://example.com now"),
            "Visit [link] now"
        );
    }

    #[test]
    fn test_removes_markdown_bold() {
        assert_eq!(
            clean_text_for_tts("This is **bold** text"),
            "This is bold text"
        );
    }

    #[test]
    fn test_removes_markdown_italic() {
        assert_eq!(
            clean_text_for_tts("This is *italic* text"),
            "This is italic text"
        );
    }

    #[test]
    fn test_removes_markdown_headers() {
        assert_eq!(clean_text_for_tts("# Header\nText"), "Header\nText");
    }

    #[test]
    fn test_removes_markdown_links() {
        assert_eq!(
            clean_text_for_tts("[click here](https://example.com)"),
            "click here"
        );
    }

    #[test]
    fn test_removes_html_tags() {
        assert_eq!(clean_text_for_tts("<b>bold</b> text"), "bold text");
    }

    #[test]
    fn test_combined_cleaning() {
        let text = "**Bold** and `code` with https://example.com";
        assert_eq!(clean_text_for_tts(text), "Bold and [code] with [link]");
    }

    #[test]
    fn test_returns_original_if_under_limit() {
        assert_eq!(truncate_text("Short text", 100), "Short text");
    }

    #[test]
    fn test_truncates_at_sentence_boundary() {
        let text = "First sentence. Second sentence. Third sentence.";
        let truncated = truncate_text(text, 20);
        assert_eq!(truncated, "First sentence.");
    }

    #[test]
    fn test_adds_ellipsis_when_truncating_mid_sentence() {
        let text = "This is a very long sentence without any breaks";
        let truncated = truncate_text(text, 20);
        assert!(truncated.ends_with("..."));
        assert!(truncated.len() <= 23); // +3 for "..."
    }

    #[test]
    fn test_truncates_at_word_boundary() {
        let text = "Word1 Word2 Word3 Word4 Word5";
        let truncated = truncate_text(text, 15);
        assert!(!truncated.contains("Word3"));
    }
}
