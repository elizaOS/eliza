//! Experience context provider for the experience plugin.

use crate::service::ExperienceService;
use crate::types::ExperienceQuery;

/// Result returned by the experience provider.
#[derive(Debug, Clone)]
pub struct ProviderResult {
    /// Formatted text for context injection.
    pub text: String,
    /// Number of relevant experiences found.
    pub experience_count: usize,
}

impl ProviderResult {
    /// Create an empty provider result.
    pub fn empty() -> Self {
        Self {
            text: String::new(),
            experience_count: 0,
        }
    }
}

/// Provider that injects relevant past experiences into LLM context.
///
/// Matches the TypeScript `experienceProvider` and Python `ExperienceProvider`.
pub struct ExperienceProvider;

impl ExperienceProvider {
    /// Provider name.
    pub const NAME: &'static str = "experienceProvider";

    /// Human-readable description.
    pub const DESCRIPTION: &'static str =
        "Provides relevant past experiences and learnings for the current context";

    /// Query relevant experiences and format them for context injection.
    ///
    /// Returns an empty result if the message text is shorter than 10 characters
    /// or no relevant experiences are found.
    pub fn get(
        service: &mut ExperienceService,
        message_text: &str,
        now_ms: i64,
    ) -> ProviderResult {
        if message_text.trim().len() < 10 {
            return ProviderResult::empty();
        }

        let query = ExperienceQuery {
            query: Some(message_text.to_string()),
            limit: Some(5),
            min_confidence: Some(0.6),
            min_importance: Some(0.5),
            ..Default::default()
        };

        let experiences = service.query_experiences(&query, now_ms);

        if experiences.is_empty() {
            return ProviderResult::empty();
        }

        let lines: Vec<String> = experiences
            .iter()
            .enumerate()
            .map(|(i, exp)| {
                format!(
                    "Experience {}: In {} context, when {}, I learned: {}",
                    i + 1,
                    exp.domain,
                    exp.context,
                    exp.learning
                )
            })
            .collect();

        let text = format!(
            "[RELEVANT EXPERIENCES]\n{}\n[/RELEVANT EXPERIENCES]",
            lines.join("\n")
        );

        let count = experiences.len();
        ProviderResult {
            text,
            experience_count: count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::ExperienceInput;
    use crate::types::ExperienceType;

    #[test]
    fn empty_for_short_messages() {
        let mut svc = ExperienceService::new(100);
        let result = ExperienceProvider::get(&mut svc, "hi", 1_700_000_000_000);
        assert!(result.text.is_empty());
        assert_eq!(result.experience_count, 0);
    }

    #[test]
    fn empty_when_no_experiences() {
        let mut svc = ExperienceService::new(100);
        let result = ExperienceProvider::get(
            &mut svc,
            "How do I install dependencies for Python scripts?",
            1_700_000_000_000,
        );
        assert!(result.text.is_empty());
        assert_eq!(result.experience_count, 0);
    }

    #[test]
    fn returns_formatted_experiences() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let input = ExperienceInput::new(
            "debugging a build".to_string(),
            "run tests".to_string(),
            "fixed missing dependency".to_string(),
            "Install dependencies before running Python scripts".to_string(),
        )
        .with_type(ExperienceType::Learning)
        .with_domain("coding".to_string())
        .with_confidence(0.9)
        .with_importance(0.8);

        svc.record_experience("agent-1", input, now);

        let result = ExperienceProvider::get(
            &mut svc,
            "How do I install dependencies for Python scripts?",
            now + 1,
        );

        assert!(result.experience_count > 0);
        assert!(result.text.contains("[RELEVANT EXPERIENCES]"));
        assert!(result.text.contains("[/RELEVANT EXPERIENCES]"));
        assert!(result.text.contains("Experience 1:"));
        assert!(result.text.contains("Install dependencies"));
    }

    #[test]
    fn formats_with_domain_and_context() {
        let mut svc = ExperienceService::new(100);
        let now = 1_700_000_000_000i64;

        let input = ExperienceInput::new(
            "network timeout".to_string(),
            "fetch api".to_string(),
            "retry worked".to_string(),
            "Always add retry logic for network calls".to_string(),
        )
        .with_domain("network".to_string())
        .with_confidence(0.8)
        .with_importance(0.7);

        svc.record_experience("agent-1", input, now);

        let result = ExperienceProvider::get(
            &mut svc,
            "How should I handle network retry logic?",
            now + 1,
        );

        assert!(result.text.contains("In network context"));
        assert!(result.text.contains("network timeout"));
        assert!(result.text.contains("retry logic"));
    }
}
