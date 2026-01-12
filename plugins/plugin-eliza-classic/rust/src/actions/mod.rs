//! ELIZA Classic actions
//!
//! Provides action implementations for the classic ELIZA chatbot.

mod generate_response;

pub use generate_response::GenerateResponseAction;

/// Action result structure
#[derive(Debug, Clone)]
pub struct ActionResult {
    /// Whether the action succeeded
    pub success: bool,
    /// Response text
    pub text: Option<String>,
    /// Error message if failed
    pub error: Option<String>,
}

/// Action example for documentation
pub struct ActionExample {
    /// Example input
    pub input: String,
    /// Example output
    pub output: String,
}

/// Returns all available actions.
pub fn get_actions() -> Vec<GenerateResponseAction> {
    vec![GenerateResponseAction]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_actions() {
        let actions = get_actions();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].name(), "generate-response");
    }
}
