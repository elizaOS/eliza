//! ELIZA Greeting Provider
//!
//! Provides the ELIZA greeting message.

use super::{ProviderContext, ProviderResult};
use crate::get_greeting;

/// Provider for the ELIZA greeting message.
pub struct ElizaGreetingProvider;

impl ElizaGreetingProvider {
    /// Returns the provider name.
    pub fn name(&self) -> &'static str {
        "eliza-greeting"
    }

    /// Returns the provider description.
    pub fn description(&self) -> &'static str {
        "Provides the ELIZA greeting message."
    }

    /// Gets the provider data.
    pub fn get(&self, _context: &ProviderContext) -> ProviderResult {
        let greeting = get_greeting();

        ProviderResult {
            text: greeting.clone(),
            values: serde_json::json!({
                "greeting": greeting
            }),
            data: serde_json::json!({
                "greeting": greeting
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eliza_greeting_provider() {
        let provider = ElizaGreetingProvider;
        let context = ProviderContext::default();

        let result = provider.get(&context);

        assert!(result.text.to_lowercase().contains("problem"));
        assert!(result.data["greeting"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("problem"));
        assert!(result.values["greeting"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("problem"));
    }

    #[test]
    fn test_provider_metadata() {
        let provider = ElizaGreetingProvider;
        assert_eq!(provider.name(), "eliza-greeting");
        assert!(provider.description().contains("greeting"));
    }
}
