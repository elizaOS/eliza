//! Configuration for the BlueBubbles plugin

use crate::error::{BlueBubblesError, Result};
use crate::types::{DmPolicy, GroupPolicy};
use serde::{Deserialize, Serialize};

/// Default webhook path
pub const DEFAULT_WEBHOOK_PATH: &str = "/webhooks/bluebubbles";

/// BlueBubbles configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueBubblesConfig {
    /// BlueBubbles server URL
    pub server_url: String,

    /// Server password
    pub password: String,

    /// Webhook path for receiving messages
    #[serde(default = "default_webhook_path")]
    pub webhook_path: String,

    /// DM policy
    #[serde(default)]
    pub dm_policy: DmPolicy,

    /// Group policy
    #[serde(default)]
    pub group_policy: GroupPolicy,

    /// Allow list for DMs
    #[serde(default)]
    pub allow_from: Vec<String>,

    /// Allow list for groups
    #[serde(default)]
    pub group_allow_from: Vec<String>,

    /// Whether to send read receipts
    #[serde(default = "default_true")]
    pub send_read_receipts: bool,

    /// Whether the plugin is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_webhook_path() -> String {
    DEFAULT_WEBHOOK_PATH.to_string()
}

fn default_true() -> bool {
    true
}

impl BlueBubblesConfig {
    /// Creates a new configuration
    pub fn new(server_url: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            server_url: server_url.into(),
            password: password.into(),
            webhook_path: DEFAULT_WEBHOOK_PATH.to_string(),
            dm_policy: DmPolicy::default(),
            group_policy: GroupPolicy::default(),
            allow_from: Vec::new(),
            group_allow_from: Vec::new(),
            send_read_receipts: true,
            enabled: true,
        }
    }

    /// Validates the configuration
    pub fn validate(&self) -> Result<()> {
        if self.server_url.is_empty() {
            return Err(BlueBubblesError::config("Server URL is required"));
        }

        if self.password.is_empty() {
            return Err(BlueBubblesError::config("Password is required"));
        }

        // Validate URL format
        url::Url::parse(&self.server_url)?;

        Ok(())
    }

    /// Creates configuration from environment variables
    pub fn from_env() -> Result<Self> {
        let server_url = std::env::var("BLUEBUBBLES_SERVER_URL")
            .map_err(|_| BlueBubblesError::config("BLUEBUBBLES_SERVER_URL not set"))?;

        let password = std::env::var("BLUEBUBBLES_PASSWORD")
            .map_err(|_| BlueBubblesError::config("BLUEBUBBLES_PASSWORD not set"))?;

        let webhook_path = std::env::var("BLUEBUBBLES_WEBHOOK_PATH")
            .unwrap_or_else(|_| DEFAULT_WEBHOOK_PATH.to_string());

        let dm_policy = std::env::var("BLUEBUBBLES_DM_POLICY")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "open" => Some(DmPolicy::Open),
                "pairing" => Some(DmPolicy::Pairing),
                "allowlist" => Some(DmPolicy::Allowlist),
                "disabled" => Some(DmPolicy::Disabled),
                _ => None,
            })
            .unwrap_or_default();

        let group_policy = std::env::var("BLUEBUBBLES_GROUP_POLICY")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "open" => Some(GroupPolicy::Open),
                "allowlist" => Some(GroupPolicy::Allowlist),
                "disabled" => Some(GroupPolicy::Disabled),
                _ => None,
            })
            .unwrap_or_default();

        let allow_from = std::env::var("BLUEBUBBLES_ALLOW_FROM")
            .ok()
            .map(|s| s.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();

        let group_allow_from = std::env::var("BLUEBUBBLES_GROUP_ALLOW_FROM")
            .ok()
            .map(|s| s.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();

        let send_read_receipts = std::env::var("BLUEBUBBLES_SEND_READ_RECEIPTS")
            .map(|s| s.to_lowercase() != "false")
            .unwrap_or(true);

        let enabled = std::env::var("BLUEBUBBLES_ENABLED")
            .map(|s| s.to_lowercase() != "false")
            .unwrap_or(true);

        let config = Self {
            server_url,
            password,
            webhook_path,
            dm_policy,
            group_policy,
            allow_from,
            group_allow_from,
            send_read_receipts,
            enabled,
        };

        config.validate()?;
        Ok(config)
    }

    /// Sets the webhook path
    pub fn with_webhook_path(mut self, path: impl Into<String>) -> Self {
        self.webhook_path = path.into();
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

    /// Adds handles to the DM allow list
    pub fn with_allow_from(mut self, handles: Vec<String>) -> Self {
        self.allow_from = handles;
        self
    }

    /// Adds handles to the group allow list
    pub fn with_group_allow_from(mut self, handles: Vec<String>) -> Self {
        self.group_allow_from = handles;
        self
    }
}

/// Normalizes a phone number or email handle
pub fn normalize_handle(handle: &str) -> String {
    let trimmed = handle.trim();

    // If it looks like an email, lowercase it
    if trimmed.contains('@') && !trimmed.starts_with('+') {
        return trimmed.to_lowercase();
    }

    // For phone numbers, strip non-digits except leading +
    let starts_with_plus = trimmed.starts_with('+');
    let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();

    // Add + prefix if it was there or if we have 10+ digits (assume international)
    if starts_with_plus || digits.len() >= 10 {
        format!("+{}", digits)
    } else {
        digits
    }
}

/// Checks if a handle is allowed based on policy
pub fn is_handle_allowed(handle: &str, allow_list: &[String], policy: DmPolicy) -> bool {
    match policy {
        DmPolicy::Open => true,
        DmPolicy::Disabled => false,
        DmPolicy::Pairing | DmPolicy::Allowlist => {
            if allow_list.is_empty() && policy == DmPolicy::Pairing {
                // Pairing mode with empty allow list allows first contact
                return true;
            }

            let normalized = normalize_handle(handle);
            allow_list
                .iter()
                .any(|allowed| normalize_handle(allowed) == normalized)
        }
    }
}

/// Checks if a handle is allowed for groups
pub fn is_group_handle_allowed(handle: &str, allow_list: &[String], policy: GroupPolicy) -> bool {
    match policy {
        GroupPolicy::Open => true,
        GroupPolicy::Disabled => false,
        GroupPolicy::Allowlist => {
            let normalized = normalize_handle(handle);
            allow_list
                .iter()
                .any(|allowed| normalize_handle(allowed) == normalized)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_handle_phone() {
        assert_eq!(normalize_handle("+1 (555) 123-4567"), "+15551234567");
        assert_eq!(normalize_handle("555-123-4567"), "+5551234567");
        assert_eq!(normalize_handle("+44 7700 900000"), "+447700900000");
    }

    #[test]
    fn test_normalize_handle_email() {
        assert_eq!(normalize_handle("User@Example.COM"), "user@example.com");
        assert_eq!(normalize_handle("  test@test.com  "), "test@test.com");
    }

    #[test]
    fn test_is_handle_allowed_open() {
        assert!(is_handle_allowed("anyone", &[], DmPolicy::Open));
    }

    #[test]
    fn test_is_handle_allowed_disabled() {
        assert!(!is_handle_allowed("anyone", &[], DmPolicy::Disabled));
    }

    #[test]
    fn test_is_handle_allowed_pairing_empty() {
        assert!(is_handle_allowed("first@contact.com", &[], DmPolicy::Pairing));
    }

    #[test]
    fn test_is_handle_allowed_allowlist() {
        let allow_list = vec!["+15551234567".to_string()];
        assert!(is_handle_allowed(
            "+1 (555) 123-4567",
            &allow_list,
            DmPolicy::Allowlist
        ));
        assert!(!is_handle_allowed(
            "+15559876543",
            &allow_list,
            DmPolicy::Allowlist
        ));
    }

    #[test]
    fn test_config_validation() {
        let config = BlueBubblesConfig::new("http://localhost:1234", "password");
        assert!(config.validate().is_ok());

        let empty_url = BlueBubblesConfig::new("", "password");
        assert!(empty_url.validate().is_err());

        let empty_password = BlueBubblesConfig::new("http://localhost:1234", "");
        assert!(empty_password.validate().is_err());
    }
}
