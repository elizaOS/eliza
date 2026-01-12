//! # ELIZA Classic Plugin
//!
//! A Rust implementation of the classic ELIZA chatbot, originally created by
//! Joseph Weizenbaum at MIT in 1966. ELIZA simulates a Rogerian psychotherapist
//! by using pattern matching and substitution to transform user input into
//! therapeutic-sounding responses.
//!
//! ## Features
//!
//! - Pattern-based response generation
//! - Pronoun reflection (e.g., "I am" → "you are")
//! - Configurable patterns and responses
//! - Response history to avoid repetition
//!
//! ## Example
//!
//! ```rust
//! use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
//!
//! let eliza = ElizaClassicPlugin::new();
//! println!("{}", eliza.get_greeting());
//! let response = eliza.generate_response("I am feeling sad today");
//! println!("{}", response);
//! ```

#![warn(missing_docs)]

pub mod actions;
pub mod interop;
pub mod patterns;
pub mod providers;
pub mod types;

use lazy_static::lazy_static;
use rand::seq::SliceRandom;
use regex::Regex;
use std::collections::HashMap;
use std::sync::Mutex;

pub use types::{ElizaConfig, ElizaPattern, ElizaRule};

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

/// Reflects pronouns in the input text to transform perspective.
///
/// This function converts first-person pronouns to second-person and vice versa,
/// which is essential for ELIZA's response generation (e.g., "I am sad" becomes
/// "you are sad").
///
/// # Arguments
///
/// * `text` - The input text to reflect
///
/// # Returns
///
/// A new string with pronouns reflected
pub fn reflect(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .map(|word| REFLECTIONS.get(word).copied().unwrap_or(word))
        .collect::<Vec<_>>()
        .join(" ")
}

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

/// The main ELIZA chatbot plugin struct.
///
/// This struct encapsulates all the state and logic needed to simulate
/// an ELIZA conversation, including pattern matching rules, default responses,
/// and response history tracking.
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
    /// Creates a new ELIZA plugin instance with default patterns and responses.
    ///
    /// # Returns
    ///
    /// A new `ElizaClassicPlugin` with the standard ELIZA patterns and responses.
    pub fn new() -> Self {
        Self {
            patterns: patterns::get_default_patterns(),
            default_responses: DEFAULT_RESPONSES.iter().map(|s| s.to_string()).collect(),
            response_history: Mutex::new(Vec::new()),
            max_history: 10,
        }
    }

    /// Creates a new ELIZA plugin instance with custom configuration.
    ///
    /// # Arguments
    ///
    /// * `config` - Custom configuration including additional patterns and responses
    ///
    /// # Returns
    ///
    /// A new `ElizaClassicPlugin` configured with the provided settings.
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

    /// Generates a response to the user's input using ELIZA's pattern matching.
    ///
    /// The method normalizes the input, searches for matching patterns,
    /// applies pronoun reflection to captured groups, and returns an
    /// appropriate therapeutic response.
    ///
    /// # Arguments
    ///
    /// * `input` - The user's input text
    ///
    /// # Returns
    ///
    /// A response string generated based on pattern matching or a default response.
    pub fn generate_response(&self, input: &str) -> String {
        let normalized = input.to_lowercase().trim().to_string();

        if normalized.is_empty() {
            return "I didn't catch that. Could you please repeat?".to_string();
        }

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
            matches.sort_by(|a, b| b.0.weight.cmp(&a.0.weight));
            let (_, best_rule, captures) = &matches[0];

            let response = self.select_response(&best_rule.responses);

            let mut result = response;
            for i in 1..=captures.len() {
                if let Some(m) = captures.get(i) {
                    let reflected = reflect(m.as_str());
                    result = result.replace(&format!("${}", i), &reflected);
                }
            }

            let placeholder_re = Regex::new(r"\$\d+").unwrap();
            result = placeholder_re.replace_all(&result, "that").to_string();

            return result;
        }

        self.select_response(&self.default_responses)
    }

    /// Returns ELIZA's greeting message to start a conversation.
    ///
    /// # Returns
    ///
    /// A greeting string introducing ELIZA as a Rogerian psychotherapist.
    pub fn get_greeting(&self) -> String {
        "Hello. I am ELIZA, a Rogerian psychotherapist simulation. How are you feeling today?"
            .to_string()
    }

    /// Clears the response history.
    ///
    /// This allows previously used responses to be selected again,
    /// useful for starting fresh conversations.
    pub fn reset_history(&self) {
        let mut history = self.response_history.lock().unwrap();
        history.clear();
    }

    fn select_response(&self, responses: &[String]) -> String {
        let mut history = self.response_history.lock().unwrap();
        let mut rng = rand::thread_rng();

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

        history.push(response.clone());
        if history.len() > self.max_history {
            history.remove(0);
        }

        response
    }
}

/// Generates a response using a shared global ELIZA instance.
///
/// This is a convenience function that uses a lazily-initialized global
/// `ElizaClassicPlugin` instance. Useful for simple use cases where
/// custom configuration is not needed.
///
/// # Arguments
///
/// * `input` - The user's input text
///
/// # Returns
///
/// A response string generated by the global ELIZA instance.
pub fn generate_response(input: &str) -> String {
    lazy_static! {
        static ref PLUGIN: ElizaClassicPlugin = ElizaClassicPlugin::new();
    }
    PLUGIN.generate_response(input)
}

/// Returns the standard ELIZA greeting message.
///
/// # Returns
///
/// A greeting string introducing ELIZA as a Rogerian psychotherapist.
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

