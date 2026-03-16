#![allow(missing_docs)]

use crate::defaults;
use crate::error::{Result, RobloxError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxConfig {
    pub api_key: String,
    pub universe_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    #[serde(default = "default_messaging_topic")]
    pub messaging_topic: String,
    #[serde(default = "default_poll_interval")]
    pub poll_interval: u64,
    #[serde(default)]
    pub dry_run: bool,
}

fn default_messaging_topic() -> String {
    defaults::MESSAGING_TOPIC.to_string()
}

fn default_poll_interval() -> u64 {
    defaults::POLL_INTERVAL
}

impl RobloxConfig {
    pub fn new(api_key: impl Into<String>, universe_id: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            universe_id: universe_id.into(),
            place_id: None,
            webhook_secret: None,
            messaging_topic: default_messaging_topic(),
            poll_interval: default_poll_interval(),
            dry_run: false,
        }
    }

    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        let api_key = std::env::var("ROBLOX_API_KEY")
            .map_err(|_| RobloxError::config("ROBLOX_API_KEY is required"))?;

        let universe_id = std::env::var("ROBLOX_UNIVERSE_ID")
            .map_err(|_| RobloxError::config("ROBLOX_UNIVERSE_ID is required"))?;

        let place_id = std::env::var("ROBLOX_PLACE_ID").ok();
        let webhook_secret = std::env::var("ROBLOX_WEBHOOK_SECRET").ok();

        let messaging_topic =
            std::env::var("ROBLOX_MESSAGING_TOPIC").unwrap_or_else(|_| default_messaging_topic());

        let poll_interval = std::env::var("ROBLOX_POLL_INTERVAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(default_poll_interval);

        let dry_run = std::env::var("ROBLOX_DRY_RUN")
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);

        Ok(Self {
            api_key,
            universe_id,
            place_id,
            webhook_secret,
            messaging_topic,
            poll_interval,
            dry_run,
        })
    }

    /// Set the place ID.
    pub fn with_place_id(mut self, place_id: impl Into<String>) -> Self {
        self.place_id = Some(place_id.into());
        self
    }

    pub fn with_webhook_secret(mut self, secret: impl Into<String>) -> Self {
        self.webhook_secret = Some(secret.into());
        self
    }

    /// Set the messaging topic.
    pub fn with_messaging_topic(mut self, topic: impl Into<String>) -> Self {
        self.messaging_topic = topic.into();
        self
    }

    /// Set the polling interval.
    pub fn with_poll_interval(mut self, interval: u64) -> Self {
        self.poll_interval = interval;
        self
    }

    pub fn with_dry_run(mut self, dry_run: bool) -> Self {
        self.dry_run = dry_run;
        self
    }

    /// Validate the configuration.
    pub fn validate(&self) -> Result<()> {
        if self.api_key.is_empty() {
            return Err(RobloxError::config("API key cannot be empty"));
        }

        if self.universe_id.is_empty() {
            return Err(RobloxError::config("Universe ID cannot be empty"));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = RobloxConfig::new("test-key", "12345");
        assert_eq!(config.api_key, "test-key");
        assert_eq!(config.universe_id, "12345");
        assert_eq!(config.messaging_topic, defaults::MESSAGING_TOPIC);
        assert_eq!(config.poll_interval, defaults::POLL_INTERVAL);
        assert!(!config.dry_run);
    }

    #[test]
    fn test_config_builder() {
        let config = RobloxConfig::new("test-key", "12345")
            .with_place_id("67890")
            .with_messaging_topic("custom-topic")
            .with_poll_interval(60)
            .with_dry_run(true);

        assert_eq!(config.place_id, Some("67890".to_string()));
        assert_eq!(config.messaging_topic, "custom-topic");
        assert_eq!(config.poll_interval, 60);
        assert!(config.dry_run);
    }

    #[test]
    fn test_config_validation() {
        let valid_config = RobloxConfig::new("test-key", "12345");
        assert!(valid_config.validate().is_ok());

        let invalid_config = RobloxConfig::new("", "12345");
        assert!(invalid_config.validate().is_err());

        let invalid_config2 = RobloxConfig::new("test-key", "");
        assert!(invalid_config2.validate().is_err());
    }
}
