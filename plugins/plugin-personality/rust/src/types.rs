//! Type definitions for the personality/character evolution plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Category of character modification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModificationType {
    /// Changes to the agent's bio/description.
    Bio,
    /// Changes to the agent's conversation style.
    Style,
    /// Changes to the agent's topics of interest.
    Topics,
    /// Changes to the agent's adjectives/personality traits.
    Adjectives,
    /// Changes to example messages.
    MessageExamples,
    /// Changes to the agent's lore/backstory.
    Lore,
    /// Changes to the system prompt.
    System,
}

/// Who initiated the modification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModificationSource {
    /// Modification initiated by the user.
    User,
    /// Modification initiated by the agent's self-reflection.
    SelfReflection,
    /// Modification initiated by the evolution evaluator.
    Evolution,
}

/// Confidence level for a proposed modification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Confidence(f64);

impl Confidence {
    pub fn new(value: f64) -> Self {
        Self(value.clamp(0.0, 1.0))
    }

    pub fn value(&self) -> f64 {
        self.0
    }

    pub fn meets_threshold(&self, threshold: f64) -> bool {
        self.0 >= threshold
    }
}

impl Default for Confidence {
    fn default() -> Self {
        Self(0.5)
    }
}

/// A proposed or applied character modification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterModification {
    pub id: Uuid,
    pub agent_id: String,
    pub modification_type: ModificationType,
    pub source: ModificationSource,
    pub field: String,
    pub old_value: Option<serde_json::Value>,
    pub new_value: serde_json::Value,
    pub reason: String,
    pub confidence: Confidence,
    pub applied: bool,
    pub created_at: DateTime<Utc>,
}

impl CharacterModification {
    pub fn new(
        agent_id: impl Into<String>,
        modification_type: ModificationType,
        source: ModificationSource,
        field: impl Into<String>,
        new_value: serde_json::Value,
        reason: impl Into<String>,
        confidence: f64,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            agent_id: agent_id.into(),
            modification_type,
            source,
            field: field.into(),
            old_value: None,
            new_value,
            reason: reason.into(),
            confidence: Confidence::new(confidence),
            applied: false,
            created_at: Utc::now(),
        }
    }
}

/// An evolution suggestion extracted from conversation analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionSuggestion {
    pub id: Uuid,
    pub agent_id: String,
    pub modification_type: ModificationType,
    pub field: String,
    pub suggested_value: serde_json::Value,
    pub reason: String,
    pub confidence: Confidence,
    pub conversation_context: String,
    pub created_at: DateTime<Utc>,
}

impl EvolutionSuggestion {
    pub fn new(
        agent_id: impl Into<String>,
        modification_type: ModificationType,
        field: impl Into<String>,
        suggested_value: serde_json::Value,
        reason: impl Into<String>,
        confidence: f64,
        context: impl Into<String>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            agent_id: agent_id.into(),
            modification_type,
            field: field.into(),
            suggested_value,
            reason: reason.into(),
            confidence: Confidence::new(confidence),
            conversation_context: context.into(),
            created_at: Utc::now(),
        }
    }
}

/// Validation result for a proposed modification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub is_safe: bool,
    pub reason: String,
    pub issues: Vec<String>,
}

impl ValidationResult {
    pub fn safe() -> Self {
        Self {
            is_safe: true,
            reason: "Modification is safe".into(),
            issues: Vec::new(),
        }
    }

    pub fn unsafe_with(reason: impl Into<String>, issues: Vec<String>) -> Self {
        Self {
            is_safe: false,
            reason: reason.into(),
            issues,
        }
    }
}

/// Configuration for the personality plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalityConfig {
    pub enable_auto_evolution: bool,
    pub evolution_cooldown_ms: u64,
    pub modification_confidence_threshold: f64,
    pub max_bio_elements: usize,
    pub max_topics: usize,
    pub require_admin_approval: bool,
    pub validate_modifications: bool,
    pub max_backups: usize,
}

impl Default for PersonalityConfig {
    fn default() -> Self {
        Self {
            enable_auto_evolution: true,
            evolution_cooldown_ms: 300_000, // 5 minutes
            modification_confidence_threshold: 0.7,
            max_bio_elements: 20,
            max_topics: 50,
            require_admin_approval: false,
            validate_modifications: true,
            max_backups: 10,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_confidence_clamping() {
        assert_eq!(Confidence::new(1.5).value(), 1.0);
        assert_eq!(Confidence::new(-0.5).value(), 0.0);
        assert_eq!(Confidence::new(0.7).value(), 0.7);
    }

    #[test]
    fn test_confidence_threshold() {
        let c = Confidence::new(0.8);
        assert!(c.meets_threshold(0.7));
        assert!(!c.meets_threshold(0.9));
    }

    #[test]
    fn test_character_modification_creation() {
        let m = CharacterModification::new(
            "agent-1",
            ModificationType::Bio,
            ModificationSource::Evolution,
            "bio",
            serde_json::json!("new bio"),
            "learned from conversation",
            0.85,
        );
        assert_eq!(m.agent_id, "agent-1");
        assert!(!m.applied);
        assert_eq!(m.confidence.value(), 0.85);
    }

    #[test]
    fn test_validation_result() {
        let safe = ValidationResult::safe();
        assert!(safe.is_safe);

        let not_safe = ValidationResult::unsafe_with(
            "Contains XSS",
            vec!["Script tag detected".into()],
        );
        assert!(!not_safe.is_safe);
        assert_eq!(not_safe.issues.len(), 1);
    }

    #[test]
    fn test_serialization() {
        let m = CharacterModification::new(
            "a",
            ModificationType::Style,
            ModificationSource::User,
            "style.all",
            serde_json::json!(["formal", "concise"]),
            "user requested",
            0.95,
        );
        let json = serde_json::to_string(&m).unwrap();
        let parsed: CharacterModification = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.field, "style.all");
    }
}
