//! Record experience action for the experience plugin.

use crate::service::{ExperienceInput, ExperienceService};
use crate::types::{Experience, ExperienceType};

/// Action that records a learning experience from user messages.
///
/// Matches the TypeScript `recordExperienceAction` and Python `RecordExperienceAction`.
pub struct RecordExperienceAction;

impl RecordExperienceAction {
    /// Canonical action name.
    pub const NAME: &'static str = "RECORD_EXPERIENCE";

    /// Alternative names that trigger this action.
    pub const SIMILES: &'static [&'static str] = &["REMEMBER", "SAVE_EXPERIENCE", "NOTE_LEARNING"];

    /// Human-readable description.
    pub const DESCRIPTION: &'static str = "Manually record a learning experience";

    /// Check whether the given message text should trigger this action.
    ///
    /// Returns `true` if the text contains "remember", "record", or "note" (case-insensitive).
    pub fn validate(message_text: &str) -> bool {
        let lower = message_text.to_ascii_lowercase();
        lower.contains("remember") || lower.contains("record") || lower.contains("note")
    }

    /// Execute the action: record an experience derived from the message text.
    pub fn handler(
        service: &mut ExperienceService,
        agent_id: &str,
        message_text: &str,
        now_ms: i64,
    ) -> Experience {
        let input = ExperienceInput::new(
            "manual".to_string(),
            "record_experience".to_string(),
            "recorded".to_string(),
            message_text.to_string(),
        )
        .with_type(ExperienceType::Learning)
        .with_domain("general".to_string())
        .with_tags(vec!["manual".to_string()])
        .with_confidence(0.9)
        .with_importance(0.6);

        service.record_experience(agent_id, input, now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_remember() {
        assert!(RecordExperienceAction::validate("Please remember this fact"));
        assert!(RecordExperienceAction::validate("REMEMBER this"));
    }

    #[test]
    fn validate_record() {
        assert!(RecordExperienceAction::validate("record this experience"));
        assert!(RecordExperienceAction::validate("Record that for later"));
    }

    #[test]
    fn validate_note() {
        assert!(RecordExperienceAction::validate("note this learning"));
    }

    #[test]
    fn validate_rejects_unrelated() {
        assert!(!RecordExperienceAction::validate("What is 2+2?"));
        assert!(!RecordExperienceAction::validate("Tell me a joke"));
        assert!(!RecordExperienceAction::validate(""));
    }

    #[test]
    fn handler_records_experience() {
        let mut svc = ExperienceService::new(100);
        let exp = RecordExperienceAction::handler(
            &mut svc,
            "agent-1",
            "Installing deps is required before running scripts",
            1_700_000_000_000,
        );
        assert_eq!(
            exp.learning,
            "Installing deps is required before running scripts"
        );
        assert_eq!(exp.domain, "general");
        assert!(exp.tags.contains(&"manual".to_string()));
        assert!((exp.confidence - 0.9).abs() < f64::EPSILON);
        assert!((exp.importance - 0.6).abs() < f64::EPSILON);
        assert_eq!(exp.experience_type, ExperienceType::Learning);
    }
}
