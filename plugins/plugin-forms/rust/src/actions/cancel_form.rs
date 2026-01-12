use super::{Action, ActionExample};

pub struct CancelFormAction;

impl CancelFormAction {
    pub fn wants_cancel(text: &str) -> bool {
        let lower = text.to_lowercase();
        
        lower.contains("cancel")
            || lower.contains("stop")
            || lower.contains("abort")
            || lower.contains("quit")
            || lower.contains("exit")
            || lower.contains("nevermind")
            || lower.contains("never mind")
            || (lower.contains("don't") && lower.contains("want"))
    }
}

impl Action for CancelFormAction {
    fn name(&self) -> &'static str {
        "CANCEL_FORM"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["ABORT_FORM", "STOP_FORM", "QUIT_FORM", "EXIT_FORM"]
    }

    fn description(&self) -> &'static str {
        "Cancels an active form"
    }

    fn validate(&self, message_text: &str, has_active_forms: bool, has_forms_service: bool) -> bool {
        if !has_forms_service {
            return false;
        }
        
        if !has_active_forms {
            return false;
        }
        
        Self::wants_cancel(message_text)
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample::user("Actually, cancel the form"),
            ActionExample::assistant(
                "I've cancelled the contact form. Is there anything else I can help you with?",
                vec!["CANCEL_FORM"],
            ),
            ActionExample::user("Never mind, I don't want to fill this out"),
            ActionExample::assistant(
                "I've cancelled the form. Is there anything else I can help you with?",
                vec!["CANCEL_FORM"],
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cancel_form_action_name() {
        let action = CancelFormAction;
        assert_eq!(action.name(), "CANCEL_FORM");
    }

    #[test]
    fn test_cancel_form_action_similes() {
        let action = CancelFormAction;
        let similes = action.similes();
        assert!(similes.contains(&"ABORT_FORM"));
        assert!(similes.contains(&"STOP_FORM"));
        assert!(similes.contains(&"QUIT_FORM"));
    }

    #[test]
    fn test_wants_cancel() {
        // Should detect cancel keywords
        assert!(CancelFormAction::wants_cancel("cancel the form"));
        assert!(CancelFormAction::wants_cancel("stop this"));
        assert!(CancelFormAction::wants_cancel("abort please"));
        assert!(CancelFormAction::wants_cancel("quit"));
        assert!(CancelFormAction::wants_cancel("exit form"));
        assert!(CancelFormAction::wants_cancel("nevermind"));
        assert!(CancelFormAction::wants_cancel("never mind"));
        assert!(CancelFormAction::wants_cancel("I don't want to do this"));
        
        // Should not detect without cancel keywords
        assert!(!CancelFormAction::wants_cancel("My name is John"));
        assert!(!CancelFormAction::wants_cancel("Continue please"));
    }

    #[test]
    fn test_validate() {
        let action = CancelFormAction;
        
        // Should validate when service available, has active forms, and wants to cancel
        assert!(action.validate("cancel the form", true, true));
        
        // Should not validate without service
        assert!(!action.validate("cancel the form", true, false));
        
        // Should not validate without active forms
        assert!(!action.validate("cancel the form", false, true));
        
        // Should not validate without cancel intent
        assert!(!action.validate("continue please", true, true));
    }

    #[test]
    fn test_examples() {
        let action = CancelFormAction;
        let examples = action.examples();
        assert!(!examples.is_empty());
        
        // Check that CANCEL_FORM action is in examples
        let has_cancel = examples.iter().any(|e| e.actions.contains(&"CANCEL_FORM"));
        assert!(has_cancel);
    }
}
