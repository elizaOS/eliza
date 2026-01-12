mod process;
mod search;

pub use process::ProcessKnowledgeAction;
pub use search::SearchKnowledgeAction;

use async_trait::async_trait;
use serde_json::Value;

pub type ActionResult<T> = std::result::Result<T, ActionError>;

#[derive(Debug)]
pub struct ActionError {
    pub message: String,
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ActionError {}

impl From<String> for ActionError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

impl From<&str> for ActionError {
    fn from(message: &str) -> Self {
        Self {
            message: message.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActionContext {
    pub message: Value,
    pub agent_id: String,
    pub room_id: Option<String>,
    pub entity_id: Option<String>,
    pub state: Value,
}

#[async_trait]
pub trait KnowledgeAction: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn validate(&self, context: &ActionContext) -> ActionResult<bool>;
    async fn execute(&self, context: &ActionContext) -> ActionResult<Value>;
}

pub fn get_actions() -> Vec<Box<dyn KnowledgeAction>> {
    vec![
        Box::new(ProcessKnowledgeAction),
        Box::new(SearchKnowledgeAction),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_actions() {
        let actions = get_actions();
        assert_eq!(actions.len(), 2);

        let names: Vec<_> = actions.iter().map(|a| a.name()).collect();
        assert!(names.contains(&"PROCESS_KNOWLEDGE"));
        assert!(names.contains(&"SEARCH_KNOWLEDGE"));
    }

    #[test]
    fn test_action_error_display() {
        let error = ActionError {
            message: "test error".to_string(),
        };
        assert_eq!(format!("{}", error), "test error");
    }

    #[test]
    fn test_action_error_from_string() {
        let error = ActionError::from("test".to_string());
        assert_eq!(error.message, "test");
    }

    #[test]
    fn test_action_error_from_str() {
        let error = ActionError::from("test");
        assert_eq!(error.message, "test");
    }
}
