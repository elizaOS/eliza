//! ELIZA Classic providers
//!
//! Provides context data for ELIZA interactions.

mod eliza_greeting;

pub use eliza_greeting::ElizaGreetingProvider;

use serde_json::Value;

/// Provider context containing runtime information.
#[derive(Debug, Clone, Default)]
pub struct ProviderContext {
    /// The agent identifier
    pub agent_id: Option<String>,
    /// The entity identifier
    pub entity_id: Option<String>,
    /// The room identifier
    pub room_id: Option<String>,
}

/// Provider result structure
#[derive(Debug, Clone)]
pub struct ProviderResult {
    /// Human-readable text
    pub text: String,
    /// Key-value pairs
    pub values: Value,
    /// Structured data
    pub data: Value,
}

/// Returns all available providers.
pub fn get_providers() -> Vec<ElizaGreetingProvider> {
    vec![ElizaGreetingProvider]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_providers() {
        let providers = get_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name(), "eliza-greeting");
    }
}
