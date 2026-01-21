//! Relationship extraction evaluator implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex::Regex;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_evaluator_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{EvaluatorResult, Memory, State};

use super::Evaluator;

/// Evaluator that extracts relationship information from conversations.
pub struct RelationshipExtractionEvaluator;

static SPEC: Lazy<&'static crate::generated::spec_helpers::EvaluatorDoc> =
    Lazy::new(|| require_evaluator_spec("RELATIONSHIP_EXTRACTION"));

impl RelationshipExtractionEvaluator {
    /// Extract platform identities from text.
    fn extract_platform_identities(text: &str) -> Vec<(String, String, f64)> {
        let mut identities = Vec::new();

        // X handles
        let x_re = Regex::new(r"@[\w]+").unwrap();
        for cap in x_re.find_iter(text) {
            let handle = cap.as_str();
            if !["@here", "@everyone", "@channel"].contains(&handle.to_lowercase().as_str()) {
                identities.push(("x".to_string(), handle.to_string(), 0.7));
            }
        }

        // Email addresses
        let email_re = Regex::new(r"[\w.+-]+@[\w.-]+\.\w+").unwrap();
        for cap in email_re.find_iter(text) {
            identities.push(("email".to_string(), cap.as_str().to_string(), 0.9));
        }

        // Discord usernames
        let discord_re = Regex::new(r"[\w]+#\d{4}").unwrap();
        for cap in discord_re.find_iter(text) {
            identities.push(("discord".to_string(), cap.as_str().to_string(), 0.8));
        }

        identities
    }

    /// Detect relationship indicators in text.
    fn detect_relationship_indicators(text: &str) -> Vec<(String, String, f64)> {
        let mut indicators = Vec::new();
        let lower = text.to_lowercase();

        // Friend indicators
        let friend_patterns = [
            "my friend",
            "good friend",
            "best friend",
            "close friend",
            "we're friends",
        ];
        for pattern in &friend_patterns {
            if lower.contains(pattern) {
                indicators.push(("friend".to_string(), "positive".to_string(), 0.8));
                break;
            }
        }

        // Colleague indicators
        let colleague_patterns = [
            "my colleague",
            "coworker",
            "co-worker",
            "work together",
            "at work",
        ];
        for pattern in &colleague_patterns {
            if lower.contains(pattern) {
                indicators.push(("colleague".to_string(), "neutral".to_string(), 0.8));
                break;
            }
        }

        // Family indicators
        let family_patterns = [
            "my brother",
            "my sister",
            "my mom",
            "my dad",
            "my mother",
            "my father",
            "my parent",
            "my son",
            "my daughter",
            "my child",
            "my family",
            "family member",
        ];
        for pattern in &family_patterns {
            if lower.contains(pattern) {
                indicators.push(("family".to_string(), "positive".to_string(), 0.9));
                break;
            }
        }

        indicators
    }
}

#[async_trait]
impl Evaluator for RelationshipExtractionEvaluator {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        message
            .content
            .text
            .as_ref()
            .map(|t| !t.is_empty())
            .unwrap_or(false)
    }

    async fn evaluate(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<EvaluatorResult> {
        let text = match &message.content.text {
            Some(t) => t,
            None => {
                return Ok(
                    EvaluatorResult::passed(50, "No text to analyze").with_data("noText", true)
                );
            }
        };

        // Extract platform identities
        let identities = Self::extract_platform_identities(text);

        // Detect relationship indicators
        let indicators = Self::detect_relationship_indicators(text);

        runtime.log_info(
            "evaluator:relationship_extraction",
            &format!(
                "Found {} identities and {} relationship indicators",
                identities.len(),
                indicators.len()
            ),
        );

        Ok(EvaluatorResult::passed(
            70,
            &format!(
                "Found {} identities and {} relationship indicators",
                identities.len(),
                indicators.len()
            ),
        )
        .with_data("identitiesCount", identities.len())
        .with_data("indicatorsCount", indicators.len()))
    }
}
