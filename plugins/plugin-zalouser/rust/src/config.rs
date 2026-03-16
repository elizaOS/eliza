//! Configuration for the Zalo User plugin.

use crate::error::{Result, ZaloUserError};
use crate::types::ZaloUserSettings;

/// Default profile name.
pub const DEFAULT_PROFILE: &str = "default";

/// Default timeout in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 30000;

/// Maximum message length.
pub const MAX_MESSAGE_LENGTH: usize = 2000;

/// zca binary name.
pub const ZCA_BINARY: &str = "zca";

/// Configuration for the Zalo User plugin.
#[derive(Debug, Clone)]
pub struct ZaloUserConfig {
    /// Cookie path for authentication persistence.
    pub cookie_path: Option<String>,
    /// IMEI for authentication.
    pub imei: Option<String>,
    /// User agent for API requests.
    pub user_agent: Option<String>,
    /// Whether plugin is enabled.
    pub enabled: bool,
    /// Default profile to use.
    pub default_profile: String,
    /// Listen timeout in milliseconds.
    pub listen_timeout: u64,
    /// Allowed thread IDs.
    pub allowed_threads: Vec<String>,
    /// DM policy: "open", "allowlist", "pairing", "disabled".
    pub dm_policy: String,
    /// Group policy: "open", "allowlist", "disabled".
    pub group_policy: String,
}

impl Default for ZaloUserConfig {
    fn default() -> Self {
        Self {
            cookie_path: None,
            imei: None,
            user_agent: None,
            enabled: true,
            default_profile: DEFAULT_PROFILE.to_string(),
            listen_timeout: DEFAULT_TIMEOUT_MS,
            allowed_threads: Vec::new(),
            dm_policy: "pairing".to_string(),
            group_policy: "disabled".to_string(),
        }
    }
}

impl ZaloUserConfig {
    /// Create a new config with the given profile.
    pub fn new(default_profile: String) -> Self {
        Self {
            default_profile,
            ..Default::default()
        }
    }

    /// Load configuration from environment variables.
    pub fn from_env() -> Self {
        let cookie_path = std::env::var("ZALOUSER_COOKIE_PATH").ok();
        let imei = std::env::var("ZALOUSER_IMEI").ok();
        let user_agent = std::env::var("ZALOUSER_USER_AGENT").ok();
        let enabled = std::env::var("ZALOUSER_ENABLED")
            .map(|v| v.to_lowercase() != "false" && v != "0")
            .unwrap_or(true);
        let default_profile = std::env::var("ZALOUSER_DEFAULT_PROFILE")
            .unwrap_or_else(|_| DEFAULT_PROFILE.to_string());
        let listen_timeout = std::env::var("ZALOUSER_LISTEN_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        let allowed_threads = parse_allowed_threads(
            std::env::var("ZALOUSER_ALLOWED_THREADS").ok().as_deref(),
        );
        let dm_policy = std::env::var("ZALOUSER_DM_POLICY")
            .unwrap_or_else(|_| "pairing".to_string());
        let group_policy = std::env::var("ZALOUSER_GROUP_POLICY")
            .unwrap_or_else(|_| "disabled".to_string());

        Self {
            cookie_path,
            imei,
            user_agent,
            enabled,
            default_profile,
            listen_timeout,
            allowed_threads,
            dm_policy,
            group_policy,
        }
    }

    /// Validate the configuration.
    pub fn validate(&self) -> Result<()> {
        if !self.enabled {
            return Err(ZaloUserError::InvalidConfig("Plugin is disabled".to_string()));
        }

        // Validate DM policy
        let valid_dm_policies = ["open", "allowlist", "pairing", "disabled"];
        if !valid_dm_policies.contains(&self.dm_policy.as_str()) {
            return Err(ZaloUserError::InvalidConfig(format!(
                "Invalid DM policy: {}. Must be one of: {:?}",
                self.dm_policy, valid_dm_policies
            )));
        }

        // Validate group policy
        let valid_group_policies = ["open", "allowlist", "disabled"];
        if !valid_group_policies.contains(&self.group_policy.as_str()) {
            return Err(ZaloUserError::InvalidConfig(format!(
                "Invalid group policy: {}. Must be one of: {:?}",
                self.group_policy, valid_group_policies
            )));
        }

        Ok(())
    }

    /// Check if a thread is allowed.
    pub fn is_thread_allowed(&self, thread_id: &str) -> bool {
        if self.allowed_threads.is_empty() {
            return true;
        }
        self.allowed_threads.contains(&thread_id.to_string())
    }

    /// Convert to settings.
    pub fn to_settings(&self) -> ZaloUserSettings {
        ZaloUserSettings {
            cookie_path: self.cookie_path.clone(),
            imei: self.imei.clone(),
            user_agent: self.user_agent.clone(),
            profiles_json: None,
            enabled: self.enabled,
            default_profile: self.default_profile.clone(),
            listen_timeout: self.listen_timeout,
            allowed_threads: self.allowed_threads.clone(),
            dm_policy: self.dm_policy.clone(),
            group_policy: self.group_policy.clone(),
        }
    }
}

/// Parse allowed threads from string (JSON array or comma-separated).
fn parse_allowed_threads(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };

    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    // Try parsing as JSON array
    if trimmed.starts_with('[') {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
            return parsed.into_iter().filter(|s| !s.is_empty()).collect();
        }
    }

    // Parse as comma-separated
    trimmed
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = ZaloUserConfig::default();
        assert!(config.enabled);
        assert_eq!(config.default_profile, DEFAULT_PROFILE);
    }

    #[test]
    fn test_parse_allowed_threads_json() {
        let threads = parse_allowed_threads(Some(r#"["123", "456"]"#));
        assert_eq!(threads, vec!["123", "456"]);
    }

    #[test]
    fn test_parse_allowed_threads_csv() {
        let threads = parse_allowed_threads(Some("123, 456, 789"));
        assert_eq!(threads, vec!["123", "456", "789"]);
    }

    #[test]
    fn test_is_thread_allowed() {
        let config = ZaloUserConfig {
            allowed_threads: vec!["123".to_string(), "456".to_string()],
            ..Default::default()
        };
        assert!(config.is_thread_allowed("123"));
        assert!(config.is_thread_allowed("456"));
        assert!(!config.is_thread_allowed("789"));
    }

    #[test]
    fn test_is_thread_allowed_empty() {
        let config = ZaloUserConfig::default();
        assert!(config.is_thread_allowed("any_thread"));
    }
}
