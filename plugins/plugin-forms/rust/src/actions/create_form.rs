use super::{Action, ActionExample};

const FORM_TYPES: &[(&str, &[&str])] = &[
    ("contact", &["contact", "reach out", "get in touch", "message"]),
    ("feedback", &["feedback", "review", "opinion", "suggestion"]),
    ("application", &["apply", "application", "job", "position"]),
    ("survey", &["survey", "questionnaire", "poll"]),
    ("registration", &["register", "sign up", "enroll", "join"]),
];

pub struct CreateFormAction;

impl CreateFormAction {
    pub fn extract_form_type(text: &str) -> Option<&'static str> {
        let lower = text.to_lowercase();
        for (form_type, keywords) in FORM_TYPES {
            if keywords.iter().any(|k| lower.contains(k)) {
                return Some(form_type);
            }
        }
        None
    }
}

impl Action for CreateFormAction {
    fn name(&self) -> &'static str {
        "CREATE_FORM"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["START_FORM", "NEW_FORM", "INIT_FORM", "BEGIN_FORM"]
    }

    fn description(&self) -> &'static str {
        "Creates a new form from a template or custom definition"
    }

    fn validate(&self, message_text: &str, _has_active_forms: bool, has_forms_service: bool) -> bool {
        if !has_forms_service {
            return false;
        }

        let text = message_text.to_lowercase();

        text.contains("form")
            || text.contains("fill out")
            || text.contains("fill in")
            || text.contains("questionnaire")
            || text.contains("survey")
            || text.contains("contact")
            || text.contains("application")
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample::user("I need to fill out a contact form"),
            ActionExample::assistant(
                "I've created a new contact form for you. Basic contact information form\n\n\
                 Let's start with Basic Information.\n\n\
                 Please provide the following information:\n\
                 - Name: Your full name\n\
                 - Email: Your email address",
                vec!["CREATE_FORM"],
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_form_action_name() {
        let action = CreateFormAction;
        assert_eq!(action.name(), "CREATE_FORM");
    }

    #[test]
    fn test_create_form_action_similes() {
        let action = CreateFormAction;
        let similes = action.similes();
        assert!(similes.contains(&"START_FORM"));
        assert!(similes.contains(&"NEW_FORM"));
    }

    #[test]
    fn test_extract_form_type() {
        assert_eq!(CreateFormAction::extract_form_type("I need a contact form"), Some("contact"));
        assert_eq!(CreateFormAction::extract_form_type("I want to give feedback"), Some("feedback"));
        assert_eq!(CreateFormAction::extract_form_type("Apply for job"), Some("application"));
        assert_eq!(CreateFormAction::extract_form_type("Take a survey"), Some("survey"));
        assert_eq!(CreateFormAction::extract_form_type("register now"), Some("registration"));
        assert_eq!(CreateFormAction::extract_form_type("hello world"), None);
    }

    #[test]
    fn test_validate_with_form_keywords() {
        let action = CreateFormAction;
        
        // Should validate when forms service is available and message contains form keywords
        assert!(action.validate("I need to fill out a form", false, true));
        assert!(action.validate("Help me with the questionnaire", false, true));
        assert!(action.validate("I want to contact you", false, true));
        
        // Should not validate without forms service
        assert!(!action.validate("I need to fill out a form", false, false));
        
        // Should not validate without form keywords
        assert!(!action.validate("Hello, how are you?", false, true));
    }

    #[test]
    fn test_examples() {
        let action = CreateFormAction;
        let examples = action.examples();
        assert!(!examples.is_empty());
        assert_eq!(examples[0].role, "user");
        assert_eq!(examples[1].role, "assistant");
        assert!(examples[1].actions.contains(&"CREATE_FORM"));
    }
}
