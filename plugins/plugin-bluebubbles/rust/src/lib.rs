//! BlueBubbles iMessage bridge plugin for elizaOS
//!
//! This plugin provides iMessage integration via the BlueBubbles macOS app and REST API.

pub mod actions;
pub mod client;
pub mod config;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

pub use client::BlueBubblesClient;
pub use config::BlueBubblesConfig;
pub use error::{BlueBubblesError, Result};
pub use service::BlueBubblesService;
pub use types::*;

use elizaos::{Action, Plugin, Provider, Service};

/// Plugin name constant
pub const BLUEBUBBLES_SERVICE_NAME: &str = "bluebubbles";

/// Creates the BlueBubbles plugin with all components
pub fn create_plugin() -> Plugin {
    Plugin {
        name: BLUEBUBBLES_SERVICE_NAME.to_string(),
        description: "BlueBubbles iMessage bridge plugin for elizaOS agents".to_string(),
        services: vec![Box::new(BlueBubblesService::new())],
        actions: vec![
            Box::new(actions::SendMessageAction::new()),
            Box::new(actions::SendReactionAction::new()),
        ],
        providers: vec![Box::new(providers::ChatStateProvider::new())],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_plugin() {
        let plugin = create_plugin();
        assert_eq!(plugin.name, BLUEBUBBLES_SERVICE_NAME);
        assert!(!plugin.description.is_empty());
        assert_eq!(plugin.services.len(), 1);
        assert_eq!(plugin.actions.len(), 2);
        assert_eq!(plugin.providers.len(), 1);
    }
}
