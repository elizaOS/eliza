#![allow(missing_docs)]

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct ElizaRule {
    pub pattern: Regex,
    pub responses: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ElizaPattern {
    pub keyword: String,
    pub weight: i32,
    pub rules: Vec<ElizaRule>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ElizaConfig {
    #[serde(default = "default_max_history")]
    pub max_history_size: usize,
    #[serde(skip)]
    pub custom_patterns: Vec<ElizaPattern>,
    #[serde(default)]
    pub custom_default_responses: Vec<String>,
}

fn default_max_history() -> usize {
    10
}

#[derive(Debug, Clone)]
pub struct ElizaMatchResult {
    pub pattern: ElizaPattern,
    pub rule: ElizaRule,
    pub captures: Vec<String>,
}
