//! Configuration for the WhatsApp plugin

use crate::error::{Result, WhatsAppError};
use serde::{Deserialize, Serialize};

/// WhatsApp API base URL
pub const WHATSAPP_API_BASE_URL: &str = "https://graph.facebook.com/v17.0";

/// WhatsApp configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhatsAppConfig {
    /// Access token for the WhatsApp Cloud API
    pub access_token: String,

    /// Phone number ID
    pub phone_number_id: String,

    /// Webhook verification token
    pub webhook_verify_token: Option<String>,

    /// Business account ID
    pub business_id: Option<String>,

    /// API version
    #[serde(default = "default_api_version")]
    pub api_version: String,

    /// Whether the plugin is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_api_version() -> String {
    "v17.0".to_string()
}

fn default_true() -> bool {
    true
}

impl WhatsAppConfig {
    /// Creates a new configuration
    pub fn new(access_token: impl Into<String>, phone_number_id: impl Into<String>) -> Self {
        Self {
            access_token: access_token.into(),
            phone_number_id: phone_number_id.into(),
            webhook_verify_token: None,
            business_id: None,
            api_version: default_api_version(),
            enabled: true,
        }
    }

    /// Validates the configuration
    pub fn validate(&self) -> Result<()> {
        if self.access_token.is_empty() {
            return Err(WhatsAppError::config("Access token is required"));
        }
        if self.phone_number_id.is_empty() {
            return Err(WhatsAppError::config("Phone number ID is required"));
        }
        Ok(())
    }

    /// Creates configuration from environment variables
    pub fn from_env() -> Result<Self> {
        let access_token = std::env::var("WHATSAPP_ACCESS_TOKEN")
            .map_err(|_| WhatsAppError::config("WHATSAPP_ACCESS_TOKEN not set"))?;

        let phone_number_id = std::env::var("WHATSAPP_PHONE_NUMBER_ID")
            .map_err(|_| WhatsAppError::config("WHATSAPP_PHONE_NUMBER_ID not set"))?;

        let webhook_verify_token = std::env::var("WHATSAPP_WEBHOOK_TOKEN").ok();
        let business_id = std::env::var("WHATSAPP_BUSINESS_ID").ok();

        let enabled = std::env::var("WHATSAPP_ENABLED")
            .map(|s| s.to_lowercase() != "false")
            .unwrap_or(true);

        let config = Self {
            access_token,
            phone_number_id,
            webhook_verify_token,
            business_id,
            api_version: default_api_version(),
            enabled,
        };

        config.validate()?;
        Ok(config)
    }

    /// Sets the webhook verify token
    pub fn with_webhook_token(mut self, token: impl Into<String>) -> Self {
        self.webhook_verify_token = Some(token.into());
        self
    }

    /// Sets the business ID
    pub fn with_business_id(mut self, id: impl Into<String>) -> Self {
        self.business_id = Some(id.into());
        self
    }

    /// Gets the API base URL
    pub fn api_base_url(&self) -> String {
        format!("https://graph.facebook.com/{}", self.api_version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_validation() {
        let config = WhatsAppConfig::new("token", "phone_id");
        assert!(config.validate().is_ok());

        let empty_token = WhatsAppConfig::new("", "phone_id");
        assert!(empty_token.validate().is_err());

        let empty_phone = WhatsAppConfig::new("token", "");
        assert!(empty_phone.validate().is_err());
    }
}
