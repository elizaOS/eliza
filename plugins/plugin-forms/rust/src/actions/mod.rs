mod cancel_form;
mod create_form;
mod update_form;

pub use cancel_form::CancelFormAction;
pub use create_form::CreateFormAction;
pub use update_form::UpdateFormAction;

use std::collections::HashMap;

pub trait Action: Send + Sync {
    fn name(&self) -> &'static str;
    fn similes(&self) -> Vec<&'static str>;
    fn description(&self) -> &'static str;
    fn validate(&self, message_text: &str, has_active_forms: bool, has_forms_service: bool)
        -> bool;
    fn examples(&self) -> Vec<ActionExample>;
}

#[derive(Debug, Clone)]
pub struct ActionExample {
    pub role: &'static str,
    pub text: &'static str,
    pub actions: Vec<&'static str>,
}

impl ActionExample {
    pub fn user(text: &'static str) -> Self {
        Self {
            role: "user",
            text,
            actions: vec![],
        }
    }

    pub fn assistant(text: &'static str, actions: Vec<&'static str>) -> Self {
        Self {
            role: "assistant",
            text,
            actions,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActionResult {
    pub success: bool,
    pub data: Option<HashMap<String, serde_json::Value>>,
    pub error: Option<String>,
}

impl ActionResult {
    pub fn success(data: HashMap<String, serde_json::Value>) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
        }
    }
}

pub fn get_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(CreateFormAction),
        Box::new(UpdateFormAction),
        Box::new(CancelFormAction),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_actions() {
        let actions = get_actions();
        assert_eq!(actions.len(), 3);

        let names: Vec<_> = actions.iter().map(|a| a.name()).collect();
        assert!(names.contains(&"CREATE_FORM"));
        assert!(names.contains(&"UPDATE_FORM"));
        assert!(names.contains(&"CANCEL_FORM"));
    }

    #[test]
    fn test_action_example() {
        let user = ActionExample::user("Test message");
        assert_eq!(user.role, "user");
        assert_eq!(user.text, "Test message");
        assert!(user.actions.is_empty());

        let assistant = ActionExample::assistant("Response", vec!["CREATE_FORM"]);
        assert_eq!(assistant.role, "assistant");
        assert_eq!(assistant.actions, vec!["CREATE_FORM"]);
    }
}
