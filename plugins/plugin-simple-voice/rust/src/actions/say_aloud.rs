#![allow(missing_docs)]

use regex::Regex;
use std::sync::Arc;
use tracing::info;

use crate::services::SamTTSService;
use crate::types::{CallbackResult, Memory, SamTTSOptions, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS};

pub fn extract_text_to_speak(message_text: &str) -> String {
    let text = message_text.to_lowercase();

    let quoted_patterns = [
        r#"say ["']([^"']+)["']"#,
        r#"speak ["']([^"']+)["']"#,
        r#"read ["']([^"']+)["']"#,
        r#"announce ["']([^"']+)["']"#,
        r#"["']([^"']+)["']"#,
    ];

    for pattern in &quoted_patterns {
        if let Ok(re) = Regex::new(pattern) {
            if let Some(caps) = re.captures(&text) {
                if let Some(m) = caps.get(1) {
                    return m.as_str().to_string();
                }
            }
        }
    }

    let keyword_patterns = [
        r"(?:say|speak|read)\s+(?:aloud\s+)?(?:this\s+)?:?\s*(.+)$",
        r"(?:can you|please)\s+(?:say|speak|read)\s+(?:aloud\s+)?(.+)$",
        r"(?:i want to hear|let me hear)\s+(.+)$",
        r"(?:read this|say this|speak this)\s*:?\s*(.+)$",
    ];

    for pattern in &keyword_patterns {
        if let Ok(re) = Regex::new(pattern) {
            if let Some(caps) = re.captures(&text) {
                if let Some(m) = caps.get(1) {
                    let mut result = m.as_str().to_string();
                    for suffix in &[" out loud", " aloud", " please"] {
                        if result.ends_with(suffix) {
                            result = result[..result.len() - suffix.len()].to_string();
                        }
                    }
                    return result.trim().to_string();
                }
            }
        }
    }

    text.trim().to_string()
}

pub fn extract_voice_options(message_text: &str) -> SamTTSOptions {
    let text = message_text.to_lowercase();
    let mut options = SamTTSOptions::default();

    if ["higher voice", "high pitch", "squeaky"]
        .iter()
        .any(|p| text.contains(p))
    {
        options.pitch = 100;
    } else if ["lower voice", "low pitch", "deep voice"]
        .iter()
        .any(|p| text.contains(p))
    {
        options.pitch = 30;
    }

    if ["faster", "quickly", "speed up"]
        .iter()
        .any(|p| text.contains(p))
    {
        options.speed = 120;
    } else if ["slower", "slowly", "slow down"]
        .iter()
        .any(|p| text.contains(p))
    {
        options.speed = 40;
    }

    if ["robotic", "robot voice"].iter().any(|p| text.contains(p)) {
        options.throat = 200;
        options.mouth = 50;
    } else if ["smooth", "natural"].iter().any(|p| text.contains(p)) {
        options.throat = 100;
        options.mouth = 150;
    }

    options
}

pub struct SayAloudAction {
    pub name: &'static str,
    pub description: &'static str,
}

impl SayAloudAction {
    pub fn new() -> Self {
        Self {
            name: "SAY_ALOUD",
            description: "Speak text aloud using SAM retro speech synthesizer",
        }
    }

    pub fn validate(&self, message: &Memory) -> bool {
        let text = message.content.text.to_lowercase();

        let has_trigger = SPEECH_TRIGGERS.iter().any(|t| text.contains(t));
        let has_intent = VOCALIZATION_PATTERNS.iter().any(|p| text.contains(p))
            || Regex::new(r#"say ["'].*["']"#)
                .map(|re| re.is_match(&text))
                .unwrap_or(false)
            || Regex::new(r#"speak ["'].*["']"#)
                .map(|re| re.is_match(&text))
                .unwrap_or(false);

        has_trigger || has_intent
    }

    pub async fn handler(&self, service: Arc<SamTTSService>, message: &Memory) -> CallbackResult {
        info!("[SAY_ALOUD] Processing speech request");

        let text_to_speak = extract_text_to_speak(&message.content.text);
        let voice_options = extract_voice_options(&message.content.text);

        info!("[SAY_ALOUD] Speaking: \"{}\"", text_to_speak);

        let audio = service
            .speak_text(&text_to_speak, Some(voice_options))
            .await;

        CallbackResult {
            text: format!("I spoke: \"{}\"", text_to_speak),
            action: "SAY_ALOUD".to_string(),
            audio_data: Some(audio),
        }
    }
}

impl Default for SayAloudAction {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::MemoryContent;

    #[test]
    fn extracts_quoted_text() {
        assert_eq!(extract_text_to_speak("say 'hello world'"), "hello world");
        assert_eq!(extract_text_to_speak("speak \"test\""), "test");
    }

    #[test]
    fn extracts_voice_options() {
        let high = extract_voice_options("speak in a higher voice");
        assert_eq!(high.pitch, 100);

        let fast = extract_voice_options("speak faster");
        assert_eq!(fast.speed, 120);
    }

    #[test]
    fn validates_triggers() {
        let action = SayAloudAction::new();

        let trigger = Memory {
            id: "1".into(),
            entity_id: "1".into(),
            agent_id: "1".into(),
            room_id: "1".into(),
            content: MemoryContent {
                text: "say aloud hello".into(),
                extra: Default::default(),
            },
            created_at: 0,
        };
        assert!(action.validate(&trigger));

        let non_trigger = Memory {
            id: "1".into(),
            entity_id: "1".into(),
            agent_id: "1".into(),
            room_id: "1".into(),
            content: MemoryContent {
                text: "hello world".into(),
                extra: Default::default(),
            },
            created_at: 0,
        };
        assert!(!action.validate(&non_trigger));
    }
}
