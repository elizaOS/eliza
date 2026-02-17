//! iMessage plugin for elizaOS
//!
//! This plugin provides iMessage integration for macOS. It uses AppleScript
//! and/or a CLI tool to send and receive messages.
//!
//! Note: This plugin only works on macOS.

pub mod actions;
pub mod config;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

pub use config::IMessageConfig;
pub use error::{IMessageError, Result};
pub use service::IMessageService;
pub use types::*;

use elizaos::{Action, Plugin, Provider, Service};

/// Plugin name constant
pub const IMESSAGE_SERVICE_NAME: &str = "imessage";

/// Creates the iMessage plugin with all components
pub fn create_plugin() -> Plugin {
    Plugin {
        name: IMESSAGE_SERVICE_NAME.to_string(),
        description: "iMessage plugin for elizaOS agents (macOS)".to_string(),
        services: vec![Box::new(IMessageService::new())],
        actions: vec![Box::new(actions::SendMessageAction::new())],
        providers: vec![Box::new(providers::ChatContextProvider::new())],
    }
}

/// Check if running on macOS
pub fn is_macos() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_plugin() {
        let plugin = create_plugin();
        assert_eq!(plugin.name, IMESSAGE_SERVICE_NAME);
        assert!(!plugin.description.is_empty());
    }

    #[test]
    fn test_is_macos() {
        #[cfg(target_os = "macos")]
        assert!(is_macos());
        #[cfg(not(target_os = "macos"))]
        assert!(!is_macos());
    }
}
