//! Generate response action for ELIZA Classic
//!
//! Uses pattern matching to generate responses in the style of the classic ELIZA chatbot.

use super::{ActionExample, ActionResult};
use crate::generate_response;

/// Action to generate ELIZA responses using classic pattern matching.
pub struct GenerateResponseAction;

impl GenerateResponseAction {
    /// Returns the action name.
    pub fn name(&self) -> &'static str {
        "generate-response"
    }

    /// Returns action aliases.
    pub fn similes(&self) -> Vec<&'static str> {
        vec!["ELIZA_RESPOND", "ELIZA_CHAT", "CLASSIC_ELIZA"]
    }

    /// Returns the action description.
    pub fn description(&self) -> &'static str {
        "Generate an ELIZA response for user input using classic pattern matching."
    }

    /// Validates whether this action should handle the message.
    pub fn validate(&self, _message_text: &str) -> bool {
        true
    }

    /// Handles the action and generates a response.
    pub fn handler(&self, user_input: &str) -> ActionResult {
        if user_input.trim().is_empty() {
            return ActionResult {
                success: false,
                text: Some(
                    "I need something to respond to. What would you like to talk about?"
                        .to_string(),
                ),
                error: Some("No user input provided".to_string()),
            };
        }

        let response = generate_response(user_input);

        ActionResult {
            success: true,
            text: Some(response),
            error: None,
        }
    }

    /// Returns action examples.
    pub fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "I am feeling very anxious today".to_string(),
                output: "I'll use ELIZA to respond.".to_string(),
            },
            ActionExample {
                input: "My mother always criticizes me".to_string(),
                output: "I'll use ELIZA to explore that with you.".to_string(),
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_metadata() {
        let action = GenerateResponseAction;
        assert_eq!(action.name(), "generate-response");
        assert!(action.similes().contains(&"ELIZA_RESPOND"));
        assert!(action.description().contains("ELIZA"));
    }

    #[test]
    fn test_validate_always_true() {
        let action = GenerateResponseAction;
        assert!(action.validate("hello"));
        assert!(action.validate(""));
    }

    #[test]
    fn test_handler_empty_input() {
        let action = GenerateResponseAction;
        let result = action.handler("");
        assert!(!result.success);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_handler_valid_input() {
        let action = GenerateResponseAction;
        let result = action.handler("I am feeling sad today");
        assert!(result.success);
        assert!(result.text.is_some());
        assert!(!result.text.unwrap().is_empty());
    }

    #[test]
    fn test_examples() {
        let action = GenerateResponseAction;
        let examples = action.examples();
        assert_eq!(examples.len(), 2);
    }
}
