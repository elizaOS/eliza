use super::{Action, ActionExample};
use regex::Regex;

pub struct UpdateFormAction;

impl UpdateFormAction {
    pub fn contains_form_input(text: &str) -> bool {
        let lower = text.to_lowercase();

        if lower.contains("my name is") || lower.contains("i am") || lower.contains("@")
        // Email
        {
            return true;
        }

        if let Ok(re) = Regex::new(r"\d{2,}") {
            if re.is_match(&lower) {
                return true;
            }
        }

        text.len() > 5
    }
}

impl Action for UpdateFormAction {
    fn name(&self) -> &'static str {
        "UPDATE_FORM"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["FILL_FORM", "SUBMIT_FORM", "COMPLETE_FORM", "FORM_INPUT"]
    }

    fn description(&self) -> &'static str {
        "Updates an active form with values extracted from the user message"
    }

    fn validate(
        &self,
        message_text: &str,
        has_active_forms: bool,
        has_forms_service: bool,
    ) -> bool {
        if !has_forms_service {
            return false;
        }

        if !has_active_forms {
            return false;
        }

        Self::contains_form_input(message_text)
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample::user("I need to fill out a contact form"),
            ActionExample::assistant(
                "I'll help you with the contact form. Please provide your name to get started.",
                vec!["CREATE_FORM"],
            ),
            ActionExample::user("My name is John Smith"),
            ActionExample::assistant(
                "Thank you, John Smith. I've recorded your name. Now, please provide your email address.",
                vec!["UPDATE_FORM"],
            ),
            ActionExample::user("john.smith@example.com"),
            ActionExample::assistant(
                "Perfect! I've recorded your email as john.smith@example.com. \
                 The last field is optional - would you like to include a message?",
                vec!["UPDATE_FORM"],
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_update_form_action_name() {
        let action = UpdateFormAction;
        assert_eq!(action.name(), "UPDATE_FORM");
    }

    #[test]
    fn test_update_form_action_similes() {
        let action = UpdateFormAction;
        let similes = action.similes();
        assert!(similes.contains(&"FILL_FORM"));
        assert!(similes.contains(&"SUBMIT_FORM"));
    }

    #[test]
    fn test_contains_form_input() {
        // Should detect name patterns
        assert!(UpdateFormAction::contains_form_input("My name is John"));
        assert!(UpdateFormAction::contains_form_input("I am 25 years old"));

        // Should detect email
        assert!(UpdateFormAction::contains_form_input("john@example.com"));

        // Should detect numbers
        assert!(UpdateFormAction::contains_form_input(
            "My phone is 1234567890"
        ));

        // Should accept longer text as potential input
        assert!(UpdateFormAction::contains_form_input(
            "This is some longer message"
        ));

        // Should reject very short messages
        assert!(!UpdateFormAction::contains_form_input("Hi"));
    }

    #[test]
    fn test_validate() {
        let action = UpdateFormAction;

        // Should validate when service available and has active forms
        assert!(action.validate("My name is John Smith", true, true));

        // Should not validate without service
        assert!(!action.validate("My name is John Smith", true, false));

        // Should not validate without active forms
        assert!(!action.validate("My name is John Smith", false, true));
    }

    #[test]
    fn test_examples() {
        let action = UpdateFormAction;
        let examples = action.examples();
        assert!(examples.len() >= 2);

        // Check that UPDATE_FORM action is in examples
        let has_update = examples.iter().any(|e| e.actions.contains(&"UPDATE_FORM"));
        assert!(has_update);
    }
}
