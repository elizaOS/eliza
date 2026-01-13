#![allow(missing_docs)]

use crate::defaults;
use crate::error::{FarcasterError, Result};
use serde::{Deserialize, Serialize};
use std::env;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum FarcasterMode {
    #[default]
    Polling,
    Webhook,
}

impl std::str::FromStr for FarcasterMode {
    type Err = FarcasterError;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "polling" => Ok(Self::Polling),
            "webhook" => Ok(Self::Webhook),
            _ => Err(FarcasterError::config(format!("Invalid mode: {}", s))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FarcasterConfig {
    pub fid: u64,
    pub signer_uuid: String,
    pub neynar_api_key: String,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub mode: FarcasterMode,
    #[serde(default = "default_max_cast_length")]
    pub max_cast_length: usize,
    #[serde(default = "default_poll_interval")]
    pub poll_interval: u64,
    #[serde(default = "default_true")]
    pub enable_cast: bool,
    #[serde(default = "default_cast_interval_min")]
    pub cast_interval_min: u64,
    #[serde(default = "default_cast_interval_max")]
    pub cast_interval_max: u64,
    #[serde(default = "default_true")]
    pub enable_action_processing: bool,
    #[serde(default = "default_action_interval")]
    pub action_interval: u64,
    #[serde(default = "default_true")]
    pub cast_immediately: bool,
    #[serde(default = "default_max_actions")]
    pub max_actions_processing: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub_url: Option<String>,
}

fn default_max_cast_length() -> usize {
    defaults::MAX_CAST_LENGTH
}

fn default_poll_interval() -> u64 {
    defaults::POLL_INTERVAL
}

fn default_cast_interval_min() -> u64 {
    defaults::CAST_INTERVAL_MIN
}

fn default_cast_interval_max() -> u64 {
    defaults::CAST_INTERVAL_MAX
}

fn default_true() -> bool {
    true
}

fn default_action_interval() -> u64 {
    1000
}

fn default_max_actions() -> u32 {
    10
}

impl FarcasterConfig {
    pub fn new(
        fid: u64,
        signer_uuid: impl Into<String>,
        neynar_api_key: impl Into<String>,
    ) -> Self {
        Self {
            fid,
            signer_uuid: signer_uuid.into(),
            neynar_api_key: neynar_api_key.into(),
            dry_run: false,
            mode: FarcasterMode::default(),
            max_cast_length: defaults::MAX_CAST_LENGTH,
            poll_interval: defaults::POLL_INTERVAL,
            enable_cast: true,
            cast_interval_min: defaults::CAST_INTERVAL_MIN,
            cast_interval_max: defaults::CAST_INTERVAL_MAX,
            enable_action_processing: true,
            action_interval: 1000,
            cast_immediately: true,
            max_actions_processing: 10,
            hub_url: None,
        }
    }

    /// Create configuration from environment variables.
    ///
    /// Required:
    /// - `FARCASTER_FID`: Farcaster ID
    /// - `FARCASTER_SIGNER_UUID`: Neynar signer UUID
    /// - `FARCASTER_NEYNAR_API_KEY`: Neynar API key
    ///
    /// Optional:
    /// - `FARCASTER_DRY_RUN`: Enable dry run mode
    /// - `FARCASTER_MODE`: 'polling' or 'webhook'
    /// - `MAX_CAST_LENGTH`: Maximum cast length
    /// - `FARCASTER_POLL_INTERVAL`: Polling interval in seconds
    /// - `ENABLE_CAST`: Enable auto-casting
    /// - `CAST_INTERVAL_MIN`: Min cast interval in minutes
    /// - `CAST_INTERVAL_MAX`: Max cast interval in minutes
    /// - `FARCASTER_HUB_URL`: Custom hub URL
    pub fn from_env() -> Result<Self> {
        // Load .env file if present
        let _ = dotenvy::dotenv();

        // Required settings
        let fid_str = env::var("FARCASTER_FID")
            .map_err(|_| FarcasterError::env("FARCASTER_FID is required"))?;
        let fid: u64 = fid_str
            .parse()
            .map_err(|_| FarcasterError::env("FARCASTER_FID must be a valid integer"))?;

        let signer_uuid = env::var("FARCASTER_SIGNER_UUID")
            .map_err(|_| FarcasterError::env("FARCASTER_SIGNER_UUID is required"))?;

        let neynar_api_key = env::var("FARCASTER_NEYNAR_API_KEY")
            .map_err(|_| FarcasterError::env("FARCASTER_NEYNAR_API_KEY is required"))?;

        let dry_run = env::var("FARCASTER_DRY_RUN")
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(false);

        let mode = env::var("FARCASTER_MODE")
            .ok()
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or_default();

        let max_cast_length = env::var("MAX_CAST_LENGTH")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(defaults::MAX_CAST_LENGTH);

        let poll_interval = env::var("FARCASTER_POLL_INTERVAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(defaults::POLL_INTERVAL);

        let enable_cast = env::var("ENABLE_CAST")
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(true);

        let cast_interval_min = env::var("CAST_INTERVAL_MIN")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(defaults::CAST_INTERVAL_MIN);

        let cast_interval_max = env::var("CAST_INTERVAL_MAX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(defaults::CAST_INTERVAL_MAX);

        let hub_url = env::var("FARCASTER_HUB_URL").ok();

        Ok(Self {
            fid,
            signer_uuid,
            neynar_api_key,
            dry_run,
            mode,
            max_cast_length,
            poll_interval,
            enable_cast,
            cast_interval_min,
            cast_interval_max,
            enable_action_processing: true,
            action_interval: 1000,
            cast_immediately: true,
            max_actions_processing: 10,
            hub_url,
        })
    }

    pub fn validate(&self) -> Result<()> {
        if self.fid == 0 {
            return Err(FarcasterError::validation(
                "FARCASTER_FID must be a positive integer",
            ));
        }
        if self.signer_uuid.is_empty() {
            return Err(FarcasterError::validation(
                "FARCASTER_SIGNER_UUID is required",
            ));
        }
        if self.neynar_api_key.is_empty() {
            return Err(FarcasterError::validation(
                "FARCASTER_NEYNAR_API_KEY is required",
            ));
        }
        if self.max_cast_length == 0 || self.max_cast_length > 1024 {
            return Err(FarcasterError::validation(
                "MAX_CAST_LENGTH must be between 1 and 1024",
            ));
        }
        if self.poll_interval == 0 {
            return Err(FarcasterError::validation(
                "FARCASTER_POLL_INTERVAL must be positive",
            ));
        }
        if self.cast_interval_max < self.cast_interval_min {
            return Err(FarcasterError::validation(
                "CAST_INTERVAL_MAX must be >= CAST_INTERVAL_MIN",
            ));
        }
        Ok(())
    }

    pub fn with_dry_run(mut self, dry_run: bool) -> Self {
        self.dry_run = dry_run;
        self
    }

    pub fn with_mode(mut self, mode: FarcasterMode) -> Self {
        self.mode = mode;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = FarcasterConfig::new(12345, "signer", "api-key");
        assert_eq!(config.fid, 12345);
        assert_eq!(config.signer_uuid, "signer");
        assert_eq!(config.neynar_api_key, "api-key");
        assert!(!config.dry_run);
    }

    #[test]
    fn test_config_validate() {
        let config = FarcasterConfig::new(12345, "signer", "api-key");
        assert!(config.validate().is_ok());

        let invalid = FarcasterConfig::new(0, "signer", "api-key");
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn test_config_with_dry_run() {
        let config = FarcasterConfig::new(12345, "signer", "api-key").with_dry_run(true);
        assert!(config.dry_run);
    }

    #[test]
    fn test_mode_parsing() {
        assert_eq!(
            "polling".parse::<FarcasterMode>().unwrap(),
            FarcasterMode::Polling
        );
        assert_eq!(
            "webhook".parse::<FarcasterMode>().unwrap(),
            FarcasterMode::Webhook
        );
        assert!("invalid".parse::<FarcasterMode>().is_err());
    }
}
