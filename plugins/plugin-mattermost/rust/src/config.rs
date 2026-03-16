use serde::{Deserialize, Serialize};

use crate::error::{MattermostError, Result};

/// DM policy options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DmPolicy {
    /// Require pairing code before allowing DMs.
    #[default]
    Pairing,
    /// Only allow DMs from users in allowlist.
    Allowlist,
    /// Allow DMs from anyone.
    Open,
    /// Disable DM handling entirely.
    Disabled,
}

/// Group policy options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GroupPolicy {
    /// Only allow messages from users in allowlist.
    #[default]
    Allowlist,
    /// Allow messages from anyone.
    Open,
    /// Disable group message handling entirely.
    Disabled,
}

/// Configuration options for the Mattermost plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostConfig {
    /// Mattermost server URL (e.g., https://chat.example.com).
    pub server_url: String,
    /// Bot token for authentication.
    pub bot_token: String,
    /// Default team ID.
    pub team_id: Option<String>,
    /// Whether the plugin is enabled.
    pub enabled: bool,
    /// Direct message policy.
    pub dm_policy: DmPolicy,
    /// Group message policy.
    pub group_policy: GroupPolicy,
    /// List of allowed user IDs or usernames.
    pub allowed_users: Vec<String>,
    /// List of allowed channel IDs.
    pub allowed_channels: Vec<String>,
    /// Whether to require @mention to respond in channels.
    pub require_mention: bool,
    /// Whether to ignore messages from bots.
    pub ignore_bot_messages: bool,
}

impl MattermostConfig {
    /// Creates a new config with sensible defaults.
    pub fn new(server_url: String, bot_token: String) -> Self {
        Self {
            server_url: normalize_server_url(&server_url),
            bot_token,
            team_id: None,
            enabled: true,
            dm_policy: DmPolicy::Pairing,
            group_policy: GroupPolicy::Allowlist,
            allowed_users: Vec::new(),
            allowed_channels: Vec::new(),
            require_mention: true,
            ignore_bot_messages: true,
        }
    }

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `MATTERMOST_SERVER_URL`
    /// - `MATTERMOST_BOT_TOKEN`
    ///
    /// Optional:
    /// - `MATTERMOST_TEAM_ID`
    /// - `MATTERMOST_ENABLED` (`true`/`false`)
    /// - `MATTERMOST_DM_POLICY` (`pairing`/`allowlist`/`open`/`disabled`)
    /// - `MATTERMOST_GROUP_POLICY` (`allowlist`/`open`/`disabled`)
    /// - `MATTERMOST_ALLOWED_USERS` (JSON array of strings)
    /// - `MATTERMOST_ALLOWED_CHANNELS` (JSON array of strings)
    /// - `MATTERMOST_REQUIRE_MENTION` (`true`/`false`)
    /// - `MATTERMOST_IGNORE_BOT_MESSAGES` (`true`/`false`)
    pub fn from_env() -> Result<Self> {
        let server_url = std::env::var("MATTERMOST_SERVER_URL")
            .map_err(|_| MattermostError::MissingSetting("MATTERMOST_SERVER_URL".to_string()))?;

        if server_url.is_empty() {
            return Err(MattermostError::ConfigError(
                "MATTERMOST_SERVER_URL cannot be empty".to_string(),
            ));
        }

        let bot_token = std::env::var("MATTERMOST_BOT_TOKEN")
            .map_err(|_| MattermostError::MissingSetting("MATTERMOST_BOT_TOKEN".to_string()))?;

        if bot_token.is_empty() {
            return Err(MattermostError::ConfigError(
                "MATTERMOST_BOT_TOKEN cannot be empty".to_string(),
            ));
        }

        let team_id = std::env::var("MATTERMOST_TEAM_ID").ok();

        let enabled = std::env::var("MATTERMOST_ENABLED")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        let dm_policy = std::env::var("MATTERMOST_DM_POLICY")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "pairing" => Some(DmPolicy::Pairing),
                "allowlist" => Some(DmPolicy::Allowlist),
                "open" => Some(DmPolicy::Open),
                "disabled" => Some(DmPolicy::Disabled),
                _ => None,
            })
            .unwrap_or_default();

        let group_policy = std::env::var("MATTERMOST_GROUP_POLICY")
            .ok()
            .and_then(|s| match s.to_lowercase().as_str() {
                "allowlist" => Some(GroupPolicy::Allowlist),
                "open" => Some(GroupPolicy::Open),
                "disabled" => Some(GroupPolicy::Disabled),
                _ => None,
            })
            .unwrap_or_default();

        let allowed_users = std::env::var("MATTERMOST_ALLOWED_USERS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let allowed_channels = std::env::var("MATTERMOST_ALLOWED_CHANNELS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let require_mention = std::env::var("MATTERMOST_REQUIRE_MENTION")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        let ignore_bot_messages = std::env::var("MATTERMOST_IGNORE_BOT_MESSAGES")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        Ok(Self {
            server_url: normalize_server_url(&server_url),
            bot_token,
            team_id,
            enabled,
            dm_policy,
            group_policy,
            allowed_users,
            allowed_channels,
            require_mention,
            ignore_bot_messages,
        })
    }

    /// Sets the team ID.
    pub fn with_team_id(mut self, team_id: String) -> Self {
        self.team_id = Some(team_id);
        self
    }

    /// Sets the enabled flag.
    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Sets the DM policy.
    pub fn with_dm_policy(mut self, policy: DmPolicy) -> Self {
        self.dm_policy = policy;
        self
    }

    /// Sets the group policy.
    pub fn with_group_policy(mut self, policy: GroupPolicy) -> Self {
        self.group_policy = policy;
        self
    }

    /// Sets the allowed users list.
    pub fn with_allowed_users(mut self, users: Vec<String>) -> Self {
        self.allowed_users = users;
        self
    }

    /// Sets the allowed channels list.
    pub fn with_allowed_channels(mut self, channels: Vec<String>) -> Self {
        self.allowed_channels = channels;
        self
    }

    /// Sets the require mention flag.
    pub fn with_require_mention(mut self, require: bool) -> Self {
        self.require_mention = require;
        self
    }

    /// Sets the ignore bot messages flag.
    pub fn with_ignore_bot_messages(mut self, ignore: bool) -> Self {
        self.ignore_bot_messages = ignore;
        self
    }

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<()> {
        if self.server_url.is_empty() {
            return Err(MattermostError::ConfigError(
                "Server URL cannot be empty".to_string(),
            ));
        }

        if self.bot_token.is_empty() {
            return Err(MattermostError::ConfigError(
                "Bot token cannot be empty".to_string(),
            ));
        }

        Ok(())
    }

    /// Returns `true` if the given user ID or username is allowed.
    pub fn is_user_allowed(&self, user_id: &str, username: Option<&str>) -> bool {
        if self.allowed_users.is_empty() {
            return true;
        }

        let allowed_lower: Vec<String> = self
            .allowed_users
            .iter()
            .map(|u| u.to_lowercase())
            .collect();

        if allowed_lower.contains(&"*".to_string()) {
            return true;
        }

        if allowed_lower.contains(&user_id.to_lowercase()) {
            return true;
        }

        if let Some(name) = username {
            if allowed_lower.contains(&name.to_lowercase()) {
                return true;
            }
        }

        false
    }

    /// Returns `true` if the given channel ID is allowed.
    pub fn is_channel_allowed(&self, channel_id: &str) -> bool {
        if self.allowed_channels.is_empty() {
            return true;
        }

        self.allowed_channels.contains(&channel_id.to_string())
    }

    /// Returns the API base URL.
    pub fn api_base_url(&self) -> String {
        format!("{}/api/v4", self.server_url)
    }
}

/// Normalizes the server URL by removing trailing slashes and /api/v4 suffix.
fn normalize_server_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Remove trailing slashes
    let mut normalized = trimmed.trim_end_matches('/').to_string();
    // Remove /api/v4 suffix if present
    if normalized.to_lowercase().ends_with("/api/v4") {
        normalized = normalized[..normalized.len() - 7].to_string();
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = MattermostConfig::new(
            "https://chat.example.com".to_string(),
            "bot_token_123".to_string(),
        );
        assert_eq!(config.server_url, "https://chat.example.com");
        assert_eq!(config.bot_token, "bot_token_123");
        assert!(config.enabled);
        assert!(config.require_mention);
    }

    #[test]
    fn test_normalize_server_url() {
        assert_eq!(
            normalize_server_url("https://chat.example.com/"),
            "https://chat.example.com"
        );
        assert_eq!(
            normalize_server_url("https://chat.example.com/api/v4"),
            "https://chat.example.com"
        );
        assert_eq!(
            normalize_server_url("https://chat.example.com/api/v4/"),
            "https://chat.example.com"
        );
    }

    #[test]
    fn test_is_user_allowed() {
        let config = MattermostConfig::new("http://localhost".to_string(), "token".to_string())
            .with_allowed_users(vec!["user1".to_string(), "user2".to_string()]);

        assert!(config.is_user_allowed("user1", None));
        assert!(config.is_user_allowed("user2", None));
        assert!(!config.is_user_allowed("user3", None));
        assert!(config.is_user_allowed("other_id", Some("user1")));
    }

    #[test]
    fn test_is_user_allowed_wildcard() {
        let config = MattermostConfig::new("http://localhost".to_string(), "token".to_string())
            .with_allowed_users(vec!["*".to_string()]);

        assert!(config.is_user_allowed("any_user", None));
    }

    #[test]
    fn test_validate_valid() {
        let config = MattermostConfig::new(
            "https://chat.example.com".to_string(),
            "bot_token_123".to_string(),
        );
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_invalid() {
        let config = MattermostConfig::new("".to_string(), "token".to_string());
        assert!(config.validate().is_err());

        let config = MattermostConfig::new("http://localhost".to_string(), "".to_string());
        assert!(config.validate().is_err());
    }
}
