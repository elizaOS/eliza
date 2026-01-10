//! Classic ELIZA Pattern Matching Plugin for elizaOS
//!
//! This crate provides a pattern matching chatbot based on Joseph Weizenbaum's
//! original 1966 ELIZA program. No LLM required.
//!
//! # Example
//!
//! ```rust
//! use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
//!
//! let plugin = ElizaClassicPlugin::new();
//! let response = plugin.generate_response("I feel sad today");
//! println!("{}", response);
//! ```

#![warn(missing_docs)]

pub mod patterns;
pub mod types;

use lazy_static::lazy_static;
use rand::seq::SliceRandom;
use regex::Regex;
use std::collections::HashMap;
use std::sync::Mutex;

pub use types::{ElizaConfig, ElizaPattern, ElizaRule};

// ============================================================================
// Pronoun Reflections
// ============================================================================

lazy_static! {
    static ref REFLECTIONS: HashMap<&'static str, &'static str> = {
        let mut m = HashMap::new();
        m.insert("am", "are");
        m.insert("was", "were");
        m.insert("i", "you");
        m.insert("i'd", "you would");
        m.insert("i've", "you have");
        m.insert("i'll", "you will");
        m.insert("my", "your");
        m.insert("are", "am");
        m.insert("you've", "I have");
        m.insert("you'll", "I will");
        m.insert("your", "my");
        m.insert("yours", "mine");
        m.insert("you", "me");
        m.insert("me", "you");
        m.insert("myself", "yourself");
        m.insert("yourself", "myself");
        m.insert("i'm", "you are");
        m
    };
}

/// Reflect pronouns in text (I → you, my → your, etc.)
pub fn reflect(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .map(|word| REFLECTIONS.get(word).copied().unwrap_or(word))
        .collect::<Vec<_>>()
        .join(" ")
}

// ============================================================================
// Default Responses
// ============================================================================

const DEFAULT_RESPONSES: &[&str] = &[
    "Very interesting.",
    "I am not sure I understand you fully.",
    "What does that suggest to you?",
    "Please continue.",
    "Go on.",
    "Do you feel strongly about discussing such things?",
    "Tell me more.",
    "That is quite interesting.",
    "Can you elaborate on that?",
    "Why do you say that?",
    "I see.",
    "What does that mean to you?",
    "How does that make you feel?",
    "Let's explore that further.",
    "Interesting. Please go on.",
];

// ============================================================================
// ELIZA Classic Plugin
// ============================================================================

/// Classic ELIZA pattern matching plugin.
///
/// Provides a testable chat response interface without requiring an LLM.
pub struct ElizaClassicPlugin {
    patterns: Vec<ElizaPattern>,
    default_responses: Vec<String>,
    response_history: Mutex<Vec<String>>,
    max_history: usize,
}

impl Default for ElizaClassicPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ElizaClassicPlugin {
    /// Create a new ELIZA Classic plugin with default patterns.
    pub fn new() -> Self {
        Self {
            patterns: patterns::get_default_patterns(),
            default_responses: DEFAULT_RESPONSES.iter().map(|s| s.to_string()).collect(),
            response_history: Mutex::new(Vec::new()),
            max_history: 10,
        }
    }

    /// Create a new plugin with custom configuration.
    pub fn with_config(config: ElizaConfig) -> Self {
        let mut patterns = patterns::get_default_patterns();
        patterns.extend(config.custom_patterns);

        let default_responses = if config.custom_default_responses.is_empty() {
            DEFAULT_RESPONSES.iter().map(|s| s.to_string()).collect()
        } else {
            config.custom_default_responses
        };

        Self {
            patterns,
            default_responses,
            response_history: Mutex::new(Vec::new()),
            max_history: config.max_history_size,
        }
    }

    /// Generate an ELIZA response for the given input.
    pub fn generate_response(&self, input: &str) -> String {
        let normalized = input.to_lowercase().trim().to_string();

        if normalized.is_empty() {
            return "I didn't catch that. Could you please repeat?".to_string();
        }

        // Find all matching patterns
        let mut matches: Vec<(&ElizaPattern, &ElizaRule, regex::Captures)> = Vec::new();

        for pattern in &self.patterns {
            if normalized.contains(&pattern.keyword) {
                for rule in &pattern.rules {
                    if let Some(captures) = rule.pattern.captures(&normalized) {
                        matches.push((pattern, rule, captures));
                    }
                }
            }
        }

        if !matches.is_empty() {
            // Sort by weight (higher = more priority)
            matches.sort_by(|a, b| b.0.weight.cmp(&a.0.weight));
            let (_, best_rule, captures) = &matches[0];

            // Select a response, avoiding recent ones
            let response = self.select_response(&best_rule.responses);

            // Substitute captured groups
            let mut result = response;
            for i in 1..=captures.len() {
                if let Some(m) = captures.get(i) {
                    let reflected = reflect(m.as_str());
                    result = result.replace(&format!("${}", i), &reflected);
                }
            }

            // Clean up remaining placeholders
            let placeholder_re = Regex::new(r"\$\d+").unwrap();
            result = placeholder_re.replace_all(&result, "that").to_string();

            return result;
        }

        // No pattern matched, use default response
        self.select_response(&self.default_responses)
    }

    /// Get the initial ELIZA greeting message.
    pub fn get_greeting(&self) -> String {
        "Hello. I am ELIZA, a Rogerian psychotherapist simulation. How are you feeling today?"
            .to_string()
    }

    /// Clear the response history.
    pub fn reset_history(&self) {
        let mut history = self.response_history.lock().unwrap();
        history.clear();
    }

    fn select_response(&self, responses: &[String]) -> String {
        let mut history = self.response_history.lock().unwrap();
        let mut rng = rand::thread_rng();

        // Filter out recently used responses
        let available: Vec<_> = responses
            .iter()
            .filter(|r| !history.contains(r))
            .collect();

        let pool = if available.is_empty() {
            responses.iter().collect::<Vec<_>>()
        } else {
            available
        };

        let response = pool.choose(&mut rng).map(|s| (*s).clone()).unwrap_or_else(|| {
            responses.first().cloned().unwrap_or_else(|| "I see.".to_string())
        });

        // Update history
        history.push(response.clone());
        if history.len() > self.max_history {
            history.remove(0);
        }

        response
    }
}

// ============================================================================
// Module-level functions
// ============================================================================

/// Generate an ELIZA response using default patterns.
pub fn generate_response(input: &str) -> String {
    lazy_static! {
        static ref PLUGIN: ElizaClassicPlugin = ElizaClassicPlugin::new();
    }
    PLUGIN.generate_response(input)
}

/// Get the default ELIZA greeting.
pub fn get_greeting() -> String {
    "Hello. I am ELIZA, a Rogerian psychotherapist simulation. How are you feeling today?"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reflect() {
        assert_eq!(reflect("i am happy"), "you are happy");
        assert_eq!(reflect("my car"), "your car");
    }

    #[test]
    fn test_greeting() {
        let plugin = ElizaClassicPlugin::new();
        let greeting = plugin.get_greeting();
        assert!(greeting.contains("ELIZA"));
    }

    #[test]
    fn test_generate_response() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("hello");
        assert!(!response.is_empty());
    }

    #[test]
    fn test_empty_input() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("");
        assert_eq!(response, "I didn't catch that. Could you please repeat?");
    }

    #[test]
    fn test_sad_response() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("I am sad");
        assert!(!response.is_empty());
    }

    #[test]
    fn test_computer_response() {
        let plugin = ElizaClassicPlugin::new();
        let response = plugin.generate_response("I think about computers");
        assert!(!response.is_empty());
    }
}

