//! Configuration types for the Tlon plugin.

use serde::{Deserialize, Serialize};

use crate::error::{Result, TlonError};

/// Configuration options for the Tlon plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonConfig {
    /// Urbit ship name (without ~).
    pub ship: String,
    /// Urbit HTTP API URL.
    pub url: String,
    /// Authentication code from +code.
    pub code: String,
    /// Whether the plugin is enabled.
    pub enabled: bool,
    /// Group channels to monitor.
    pub group_channels: Vec<String>,
    /// Ships allowed to send DMs.
    pub dm_allowlist: Vec<String>,
    /// Whether to auto-discover channels.
    pub auto_discover_channels: bool,
}

impl TlonConfig {
    /// Creates a new config with sensible defaults.
    pub fn new(ship: String, url: String, code: String) -> Self {
        Self {
            ship: normalize_ship(&ship),
            url: url.trim_end_matches('/').to_string(),
            code,
            enabled: true,
            group_channels: Vec::new(),
            dm_allowlist: Vec::new(),
            auto_discover_channels: true,
        }
    }

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `TLON_SHIP`
    /// - `TLON_URL`
    /// - `TLON_CODE`
    ///
    /// Optional:
    /// - `TLON_ENABLED` (`true`/`false`)
    /// - `TLON_GROUP_CHANNELS` (JSON array)
    /// - `TLON_DM_ALLOWLIST` (JSON array)
    /// - `TLON_AUTO_DISCOVER_CHANNELS` (`true`/`false`)
    pub fn from_env() -> Result<Self> {
        let ship = std::env::var("TLON_SHIP")
            .map_err(|_| TlonError::MissingSetting("TLON_SHIP".to_string()))?;

        let url = std::env::var("TLON_URL")
            .map_err(|_| TlonError::MissingSetting("TLON_URL".to_string()))?;

        let code = std::env::var("TLON_CODE")
            .map_err(|_| TlonError::MissingSetting("TLON_CODE".to_string()))?;

        let enabled = std::env::var("TLON_ENABLED")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        let group_channels = std::env::var("TLON_GROUP_CHANNELS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let dm_allowlist: Vec<String> = std::env::var("TLON_DM_ALLOWLIST")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let auto_discover_channels = std::env::var("TLON_AUTO_DISCOVER_CHANNELS")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        Ok(Self {
            ship: normalize_ship(&ship),
            url: url.trim_end_matches('/').to_string(),
            code,
            enabled,
            group_channels,
            dm_allowlist: dm_allowlist.into_iter().map(|s| normalize_ship(&s)).collect(),
            auto_discover_channels,
        })
    }

    /// Sets group channels to monitor.
    pub fn with_group_channels(mut self, channels: Vec<String>) -> Self {
        self.group_channels = channels;
        self
    }

    /// Sets the DM allowlist.
    pub fn with_dm_allowlist(mut self, ships: Vec<String>) -> Self {
        self.dm_allowlist = ships.into_iter().map(|s| normalize_ship(&s)).collect();
        self
    }

    /// Enables or disables auto-discovery.
    pub fn with_auto_discover(mut self, auto_discover: bool) -> Self {
        self.auto_discover_channels = auto_discover;
        self
    }

    /// Enables or disables the plugin.
    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<()> {
        if self.ship.is_empty() {
            return Err(TlonError::ConfigError("Ship name cannot be empty".to_string()));
        }

        if self.url.is_empty() {
            return Err(TlonError::ConfigError("URL cannot be empty".to_string()));
        }

        if self.code.is_empty() {
            return Err(TlonError::ConfigError("Code cannot be empty".to_string()));
        }

        // Validate URL format
        url::Url::parse(&self.url)?;

        Ok(())
    }

    /// Returns whether a ship is in the DM allowlist.
    pub fn is_dm_allowed(&self, ship: &str) -> bool {
        if self.dm_allowlist.is_empty() {
            return true;
        }
        let normalized = normalize_ship(ship);
        self.dm_allowlist.iter().any(|s| s == &normalized)
    }

    /// Returns the ship name with ~ prefix.
    pub fn formatted_ship(&self) -> String {
        format_ship(&self.ship)
    }
}

/// Normalizes a ship name by removing the ~ prefix if present.
pub fn normalize_ship(ship: &str) -> String {
    ship.trim_start_matches('~').to_string()
}

/// Formats a ship name with the ~ prefix.
pub fn format_ship(ship: &str) -> String {
    let normalized = normalize_ship(ship);
    format!("~{}", normalized)
}

/// Parses a channel nest string (e.g., "chat/~host/channel-name").
pub fn parse_channel_nest(nest: &str) -> Option<(String, String, String)> {
    let parts: Vec<&str> = nest.split('/').collect();
    if parts.len() != 3 {
        return None;
    }

    let kind = parts[0].to_string();
    let host_ship = normalize_ship(parts[1]);
    let channel_name = parts[2].to_string();

    Some((kind, host_ship, channel_name))
}

/// Builds a channel nest string from components.
pub fn build_channel_nest(kind: &str, host_ship: &str, channel_name: &str) -> String {
    format!("{}/{}/{}", kind, format_ship(host_ship), channel_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = TlonConfig::new(
            "~sampel-palnet".to_string(),
            "https://sampel-palnet.tlon.network".to_string(),
            "lidlut-tabwed".to_string(),
        );
        assert_eq!(config.ship, "sampel-palnet");
        assert!(!config.url.ends_with('/'));
        assert!(config.enabled);
    }

    #[test]
    fn test_normalize_ship() {
        assert_eq!(normalize_ship("~sampel-palnet"), "sampel-palnet");
        assert_eq!(normalize_ship("sampel-palnet"), "sampel-palnet");
    }

    #[test]
    fn test_format_ship() {
        assert_eq!(format_ship("sampel-palnet"), "~sampel-palnet");
        assert_eq!(format_ship("~sampel-palnet"), "~sampel-palnet");
    }

    #[test]
    fn test_parse_channel_nest() {
        let result = parse_channel_nest("chat/~host-ship/channel-name");
        assert!(result.is_some());
        let (kind, host, name) = result.unwrap();
        assert_eq!(kind, "chat");
        assert_eq!(host, "host-ship");
        assert_eq!(name, "channel-name");
    }

    #[test]
    fn test_parse_channel_nest_invalid() {
        assert!(parse_channel_nest("invalid").is_none());
        assert!(parse_channel_nest("only/two").is_none());
    }

    #[test]
    fn test_is_dm_allowed() {
        let config = TlonConfig::new(
            "myship".to_string(),
            "https://example.com".to_string(),
            "code".to_string(),
        )
        .with_dm_allowlist(vec!["allowed-ship".to_string()]);

        assert!(config.is_dm_allowed("allowed-ship"));
        assert!(config.is_dm_allowed("~allowed-ship"));
        assert!(!config.is_dm_allowed("other-ship"));

        // Empty allowlist allows all
        let open_config = TlonConfig::new(
            "myship".to_string(),
            "https://example.com".to_string(),
            "code".to_string(),
        );
        assert!(open_config.is_dm_allowed("any-ship"));
    }
}
