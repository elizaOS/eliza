//! WhatsApp Cloud API plugin for ElizaOS
//!
//! This plugin provides WhatsApp integration via Meta's Cloud API.

pub mod actions;
pub mod client;
pub mod config;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

pub use client::WhatsAppClient;
pub use config::WhatsAppConfig;
pub use error::{Result, WhatsAppError};
pub use service::WhatsAppService;
pub use types::*;

/// Plugin name constant
pub const WHATSAPP_SERVICE_NAME: &str = "whatsapp";

/// Plugin metadata
#[derive(Debug, Clone)]
pub struct WhatsAppPlugin {
    /// Plugin name
    pub name: String,
    /// Plugin description
    pub description: String,
}

impl WhatsAppPlugin {
    /// Create a new plugin instance
    pub fn new() -> Self {
        Self {
            name: WHATSAPP_SERVICE_NAME.to_string(),
            description: "WhatsApp Cloud API plugin for ElizaOS agents".to_string(),
        }
    }
}

impl Default for WhatsAppPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// Creates the WhatsApp plugin metadata
pub fn create_plugin() -> WhatsAppPlugin {
    WhatsAppPlugin::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_plugin() {
        let plugin = create_plugin();
        assert_eq!(plugin.name, WHATSAPP_SERVICE_NAME);
    }
}
