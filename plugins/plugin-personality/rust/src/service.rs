//! In-memory service for character modification tracking and validation.

use crate::types::*;
use std::collections::VecDeque;
use uuid::Uuid;

/// Service that manages character modifications, evolution suggestions,
/// and safety validation.
pub struct PersonalityService {
    config: PersonalityConfig,
    modifications: VecDeque<CharacterModification>,
    suggestions: VecDeque<EvolutionSuggestion>,
    last_evolution_at_ms: u64,
}

impl PersonalityService {
    pub fn new(config: PersonalityConfig) -> Self {
        Self {
            config,
            modifications: VecDeque::new(),
            suggestions: VecDeque::new(),
            last_evolution_at_ms: 0,
        }
    }

    pub fn config(&self) -> &PersonalityConfig {
        &self.config
    }

    /// Record a character modification (applied or proposed).
    pub fn record_modification(&mut self, modification: CharacterModification) {
        self.modifications.push_back(modification);
        // Keep bounded
        while self.modifications.len() > 1000 {
            self.modifications.pop_front();
        }
    }

    /// Record an evolution suggestion.
    pub fn record_suggestion(&mut self, suggestion: EvolutionSuggestion) {
        self.suggestions.push_back(suggestion);
        while self.suggestions.len() > 500 {
            self.suggestions.pop_front();
        }
    }

    /// Get all modifications for an agent.
    pub fn get_modifications(&self, agent_id: &str) -> Vec<&CharacterModification> {
        self.modifications
            .iter()
            .filter(|m| m.agent_id == agent_id)
            .collect()
    }

    /// Get pending (unapplied) suggestions for an agent.
    pub fn get_pending_suggestions(&self, agent_id: &str) -> Vec<&EvolutionSuggestion> {
        self.suggestions
            .iter()
            .filter(|s| s.agent_id == agent_id)
            .collect()
    }

    /// Check if evolution cooldown has elapsed.
    pub fn can_evolve(&self, now_ms: u64) -> bool {
        if !self.config.enable_auto_evolution {
            return false;
        }
        // First evolution is always allowed (last_evolution_at_ms == 0 means never evolved)
        if self.last_evolution_at_ms == 0 {
            return true;
        }
        now_ms.saturating_sub(self.last_evolution_at_ms) >= self.config.evolution_cooldown_ms
    }

    /// Mark that evolution was performed.
    pub fn mark_evolution(&mut self, now_ms: u64) {
        self.last_evolution_at_ms = now_ms;
    }

    /// Validate a proposed modification for safety.
    pub fn validate_modification(&self, modification: &CharacterModification) -> ValidationResult {
        let mut issues = Vec::new();

        // Check confidence threshold
        if !modification
            .confidence
            .meets_threshold(self.config.modification_confidence_threshold)
        {
            issues.push(format!(
                "Confidence {:.2} below threshold {:.2}",
                modification.confidence.value(),
                self.config.modification_confidence_threshold
            ));
        }

        // Check for XSS patterns in the new value
        let value_str = modification.new_value.to_string();
        if value_str.contains("<script") || value_str.contains("javascript:") {
            issues.push("Potential XSS content detected".into());
        }

        // Check field-specific limits
        match modification.modification_type {
            ModificationType::Bio => {
                if let Some(arr) = modification.new_value.as_array() {
                    if arr.len() > self.config.max_bio_elements {
                        issues.push(format!(
                            "Bio has {} elements, max is {}",
                            arr.len(),
                            self.config.max_bio_elements
                        ));
                    }
                }
            }
            ModificationType::Topics => {
                if let Some(arr) = modification.new_value.as_array() {
                    if arr.len() > self.config.max_topics {
                        issues.push(format!(
                            "Topics has {} elements, max is {}",
                            arr.len(),
                            self.config.max_topics
                        ));
                    }
                }
            }
            _ => {}
        }

        // Check string length limits
        if let Some(s) = modification.new_value.as_str() {
            if s.len() > 10_000 {
                issues.push("Value exceeds maximum length (10000 chars)".into());
            }
        }

        if issues.is_empty() {
            ValidationResult::safe()
        } else {
            ValidationResult::unsafe_with("Modification failed validation", issues)
        }
    }

    /// Mark a modification as applied.
    pub fn mark_applied(&mut self, modification_id: Uuid) -> bool {
        for m in self.modifications.iter_mut() {
            if m.id == modification_id {
                m.applied = true;
                return true;
            }
        }
        false
    }

    /// Get modification history stats.
    pub fn stats(&self, agent_id: &str) -> PersonalityStats {
        let mods = self.get_modifications(agent_id);
        let applied = mods.iter().filter(|m| m.applied).count();
        let pending = self
            .suggestions
            .iter()
            .filter(|s| s.agent_id == agent_id)
            .count();

        PersonalityStats {
            total_modifications: mods.len(),
            applied_modifications: applied,
            pending_suggestions: pending,
            last_evolution_at_ms: self.last_evolution_at_ms,
        }
    }
}

/// Statistics for personality modifications.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PersonalityStats {
    pub total_modifications: usize,
    pub applied_modifications: usize,
    pub pending_suggestions: usize,
    pub last_evolution_at_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> PersonalityConfig {
        PersonalityConfig {
            evolution_cooldown_ms: 1000,
            modification_confidence_threshold: 0.7,
            ..PersonalityConfig::default()
        }
    }

    #[test]
    fn test_record_and_retrieve_modification() {
        let mut svc = PersonalityService::new(test_config());
        let m = CharacterModification::new(
            "agent-1",
            ModificationType::Bio,
            ModificationSource::Evolution,
            "bio",
            serde_json::json!(["curious", "helpful"]),
            "learned from conversation",
            0.85,
        );
        svc.record_modification(m);
        assert_eq!(svc.get_modifications("agent-1").len(), 1);
        assert_eq!(svc.get_modifications("agent-2").len(), 0);
    }

    #[test]
    fn test_evolution_cooldown() {
        let mut svc = PersonalityService::new(test_config());
        assert!(svc.can_evolve(0));
        svc.mark_evolution(1000);
        assert!(!svc.can_evolve(1500)); // 500ms < 1000ms cooldown
        assert!(svc.can_evolve(2000)); // 1000ms >= 1000ms cooldown
    }

    #[test]
    fn test_validation_xss() {
        let svc = PersonalityService::new(test_config());
        let m = CharacterModification::new(
            "a",
            ModificationType::Bio,
            ModificationSource::User,
            "bio",
            serde_json::json!("<script>alert('xss')</script>"),
            "test",
            0.9,
        );
        let result = svc.validate_modification(&m);
        assert!(!result.is_safe);
        assert!(result.issues.iter().any(|i| i.contains("XSS")));
    }

    #[test]
    fn test_validation_low_confidence() {
        let svc = PersonalityService::new(test_config());
        let m = CharacterModification::new(
            "a",
            ModificationType::Style,
            ModificationSource::Evolution,
            "style",
            serde_json::json!("casual"),
            "test",
            0.3, // Below 0.7 threshold
        );
        let result = svc.validate_modification(&m);
        assert!(!result.is_safe);
        assert!(result.issues.iter().any(|i| i.contains("Confidence")));
    }

    #[test]
    fn test_validation_bio_limit() {
        let svc = PersonalityService::new(PersonalityConfig {
            max_bio_elements: 3,
            ..test_config()
        });
        let m = CharacterModification::new(
            "a",
            ModificationType::Bio,
            ModificationSource::User,
            "bio",
            serde_json::json!(["a", "b", "c", "d", "e"]),
            "test",
            0.9,
        );
        let result = svc.validate_modification(&m);
        assert!(!result.is_safe);
    }

    #[test]
    fn test_mark_applied() {
        let mut svc = PersonalityService::new(test_config());
        let m = CharacterModification::new(
            "a",
            ModificationType::Bio,
            ModificationSource::User,
            "bio",
            serde_json::json!("new"),
            "test",
            0.9,
        );
        let id = m.id;
        svc.record_modification(m);
        assert!(svc.mark_applied(id));
        assert!(svc.get_modifications("a")[0].applied);
    }

    #[test]
    fn test_stats() {
        let mut svc = PersonalityService::new(test_config());
        let mut m = CharacterModification::new(
            "a",
            ModificationType::Bio,
            ModificationSource::User,
            "bio",
            serde_json::json!("v1"),
            "test",
            0.9,
        );
        m.applied = true;
        svc.record_modification(m);
        svc.record_modification(CharacterModification::new(
            "a",
            ModificationType::Style,
            ModificationSource::Evolution,
            "style",
            serde_json::json!("v2"),
            "test",
            0.8,
        ));
        svc.record_suggestion(EvolutionSuggestion::new(
            "a",
            ModificationType::Topics,
            "topics",
            serde_json::json!(["rust"]),
            "new interest",
            0.75,
            "discussed rust programming",
        ));

        let stats = svc.stats("a");
        assert_eq!(stats.total_modifications, 2);
        assert_eq!(stats.applied_modifications, 1);
        assert_eq!(stats.pending_suggestions, 1);
    }
}
