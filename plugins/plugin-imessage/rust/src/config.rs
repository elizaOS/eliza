//! Configuration for the iMessage plugin

use crate::error::{IMessageError, Result};
use crate::types::{DmPolicy, GroupPolicy, DEFAULT_POLL_INTERVAL_MS};
use serde::{Deserialize, Serialize};

/// iMessage configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessageConfig {
    /// Path to iMessage CLI tool
    #[serde(default = "default_cli_path")]
    pub cli_path: String,

    /// Path to iMessage database
    pub db_path: Option<String>,

    /// Polling interval in milliseconds
    #[serde(default = "default_poll_interval")]
    pub poll_interval_ms: u64,

    /// DM policy
    #[serde(default)]
    pub dm_policy: DmPolicy,

    /// Group policy
    #[serde(default)]
    pub group_policy: GroupPolicy,

    /// Handles/phone numbers for allowlist
    #[serde(default)]
    pub allow_from: Vec<String>,

    /// Enable/disable the plugin
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_cli_path() -> String {
    "imsg".to_string()
}

fn default_poll_interval() -> u64 {
    DEFAULT_POLL_INTERVAL_MS
}

fn default_true() -> bool {
    true
}

impl Default for IMessageConfig {
    fn default() -> Self {
        Self {
            cli_path: default_cli_path(),
            db_path: None,
            poll_interval_ms: default_poll_interval(),
            dm_policy: DmPolicy::default(),
            group_policy: GroupPolicy::default(),
            allow_from: Vec::new(),
            enabled: true,
        }
    }
}

impl IMessageConfig {
    /// Creates a new configuration
    pub fn new() -> Self {
        Self::default()
    }

    /// Validates the configuration
    pub fn validate(&self) -> Result<()> {
        // Only validate on macOS
        #[cfg(not(target_os = "macos"))]
        return Err(IMessageError::NotSupported);

        #[cfg(target_os = "macos")]
        {
            // CLI path validation would happen at runtime when we try to use it
            Ok(())
        }
    }

    /// Creates configuration from environment variables
    pub fn from_env() -> Result<Self> {
        let cli_path = std::env::var("IMESSAGE_CLI_PATH").unwrap_or_else(|_| "imsg".to_string());

        let db_path = std::env::var("IMESSAGE_DB_PATH").ok();

        let poll_interval_ms = std::env::var("IMESSAGE_POLL_INTERVAL_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_POLL_INTERVAL_MS);

        let dm_policy = std::env::var("IMESSAGE_DM_POLICY")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "open" => Some(DmPolicy::Open),
                "pairing" => Some(DmPolicy::Pairing),
                "allowlist" => Some(DmPolicy::Allowlist),
                "disabled" => Some(DmPolicy::Disabled),
                _ => None,
            })
            .unwrap_or_default();

        let group_policy = std::env::var("IMESSAGE_GROUP_POLICY")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "open" => Some(GroupPolicy::Open),
                "allowlist" => Some(GroupPolicy::Allowlist),
                "disabled" => Some(GroupPolicy::Disabled),
                _ => None,
            })
            .unwrap_or_default();

        let allow_from = std::env::var("IMESSAGE_ALLOW_FROM")
            .ok()
            .map(|s| s.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();

        let enabled = std::env::var("IMESSAGE_ENABLED")
            .map(|s| s.to_lowercase() != "false")
            .unwrap_or(true);

        let config = Self {
            cli_path,
            db_path,
            poll_interval_ms,
            dm_policy,
            group_policy,
            allow_from,
            enabled,
        };

        config.validate()?;
        Ok(config)
    }

    /// Sets the CLI path
    pub fn with_cli_path(mut self, path: impl Into<String>) -> Self {
        self.cli_path = path.into();
        self
    }

    /// Sets the database path
    pub fn with_db_path(mut self, path: impl Into<String>) -> Self {
        self.db_path = Some(path.into());
        self
    }

    /// Sets the poll interval
    pub fn with_poll_interval(mut self, ms: u64) -> Self {
        self.poll_interval_ms = ms;
        self
    }

    /// Sets the DM policy
    pub fn with_dm_policy(mut self, policy: DmPolicy) -> Self {
        self.dm_policy = policy;
        self
    }

    /// Sets the group policy
    pub fn with_group_policy(mut self, policy: GroupPolicy) -> Self {
        self.group_policy = policy;
        self
    }

    /// Check if a handle is allowed based on policy
    pub fn is_allowed(&self, handle: &str) -> bool {
        match self.dm_policy {
            DmPolicy::Open => true,
            DmPolicy::Disabled => false,
            DmPolicy::Pairing => true, // Allow and track
            DmPolicy::Allowlist => self
                .allow_from
                .iter()
                .any(|a| a.to_lowercase() == handle.to_lowercase()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = IMessageConfig::default();
        assert_eq!(config.cli_path, "imsg");
        assert!(config.enabled);
        assert_eq!(config.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
    }

    #[test]
    fn test_is_allowed_open() {
        let config = IMessageConfig::default().with_dm_policy(DmPolicy::Open);
        assert!(config.is_allowed("anyone"));
    }

    #[test]
    fn test_is_allowed_disabled() {
        let config = IMessageConfig::default().with_dm_policy(DmPolicy::Disabled);
        assert!(!config.is_allowed("anyone"));
    }

    #[test]
    fn test_is_allowed_allowlist() {
        let mut config = IMessageConfig::default().with_dm_policy(DmPolicy::Allowlist);
        config.allow_from = vec!["+15551234567".to_string()];
        assert!(config.is_allowed("+15551234567"));
        assert!(!config.is_allowed("+15559876543"));
    }
}
