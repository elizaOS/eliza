//! Types for ELIZA Classic Plugin.

use regex::Regex;
use serde::{Deserialize, Serialize};

/// A pattern rule with regex and response templates.
#[derive(Debug, Clone)]
pub struct ElizaRule {
    /// Regex pattern to match against input.
    pub pattern: Regex,
    /// Response templates with $1, $2, etc. placeholders.
    pub responses: Vec<String>,
}

/// A keyword pattern group with weight and rules.
#[derive(Debug, Clone)]
pub struct ElizaPattern {
    /// Keyword to trigger this pattern group.
    pub keyword: String,
    /// Priority weight (higher = more priority).
    pub weight: i32,
    /// Rules to apply when keyword matches.
    pub rules: Vec<ElizaRule>,
}

/// Configuration for ELIZA response generation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ElizaConfig {
    /// Maximum responses to remember for avoiding repetition.
    #[serde(default = "default_max_history")]
    pub max_history_size: usize,
    /// Custom patterns to add to defaults.
    #[serde(skip)]
    pub custom_patterns: Vec<ElizaPattern>,
    /// Custom default responses.
    #[serde(default)]
    pub custom_default_responses: Vec<String>,
}

fn default_max_history() -> usize {
    10
}

/// Result of ELIZA pattern matching.
#[derive(Debug, Clone)]
pub struct ElizaMatchResult {
    /// The matched pattern.
    pub pattern: ElizaPattern,
    /// The matched rule.
    pub rule: ElizaRule,
    /// Captured groups from the regex.
    pub captures: Vec<String>,
}




