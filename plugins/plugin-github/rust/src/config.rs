//! GitHub plugin configuration
//!
//! Configuration can be loaded from environment variables or constructed programmatically.

use serde::{Deserialize, Serialize};

use crate::error::{GitHubError, Result};

/// GitHub plugin configuration
///
/// Contains all settings required to interact with the GitHub API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubConfig {
    /// API token for authentication (required)
    pub api_token: String,

    /// Default repository owner
    pub owner: Option<String>,

    /// Default repository name
    pub repo: Option<String>,

    /// Default branch
    #[serde(default = "default_branch")]
    pub branch: String,

    /// Webhook secret for verification
    pub webhook_secret: Option<String>,

    /// GitHub App ID
    pub app_id: Option<String>,

    /// GitHub App private key
    pub app_private_key: Option<String>,

    /// GitHub App installation ID
    pub installation_id: Option<String>,
}

fn default_branch() -> String {
    "main".to_string()
}

impl GitHubConfig {
    /// Create a new configuration with required API token.
    ///
    /// # Arguments
    ///
    /// * `api_token` - GitHub personal access token
    ///
    /// # Example
    ///
    /// ```
    /// use elizaos_plugin_github::GitHubConfig;
    ///
    /// let config = GitHubConfig::new("ghp_your_token_here".to_string());
    /// ```
    pub fn new(api_token: String) -> Self {
        Self {
            api_token,
            owner: None,
            repo: None,
            branch: default_branch(),
            webhook_secret: None,
            app_id: None,
            app_private_key: None,
            installation_id: None,
        }
    }

    /// Load configuration from environment variables.
    ///
    /// # Required Variables
    ///
    /// - `GITHUB_API_TOKEN`: Personal access token
    ///
    /// # Optional Variables
    ///
    /// - `GITHUB_OWNER`: Default repository owner
    /// - `GITHUB_REPO`: Default repository name
    /// - `GITHUB_BRANCH`: Default branch (defaults to "main")
    /// - `GITHUB_WEBHOOK_SECRET`: Webhook secret
    /// - `GITHUB_APP_ID`: GitHub App ID
    /// - `GITHUB_APP_PRIVATE_KEY`: GitHub App private key
    /// - `GITHUB_INSTALLATION_ID`: GitHub App installation ID
    ///
    /// # Errors
    ///
    /// Returns `GitHubError::MissingSetting` if required variables are missing.
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        let api_token = std::env::var("GITHUB_API_TOKEN")
            .map_err(|_| GitHubError::MissingSetting("GITHUB_API_TOKEN".to_string()))?;

        if api_token.is_empty() {
            return Err(GitHubError::ConfigError(
                "GITHUB_API_TOKEN cannot be empty".to_string(),
            ));
        }

        Ok(Self {
            api_token,
            owner: std::env::var("GITHUB_OWNER").ok(),
            repo: std::env::var("GITHUB_REPO").ok(),
            branch: std::env::var("GITHUB_BRANCH").unwrap_or_else(|_| default_branch()),
            webhook_secret: std::env::var("GITHUB_WEBHOOK_SECRET").ok(),
            app_id: std::env::var("GITHUB_APP_ID").ok(),
            app_private_key: std::env::var("GITHUB_APP_PRIVATE_KEY").ok(),
            installation_id: std::env::var("GITHUB_INSTALLATION_ID").ok(),
        })
    }

    /// Set owner (builder pattern)
    pub fn with_owner(mut self, owner: String) -> Self {
        self.owner = Some(owner);
        self
    }

    /// Set repository (builder pattern)
    pub fn with_repo(mut self, repo: String) -> Self {
        self.repo = Some(repo);
        self
    }

    /// Set branch (builder pattern)
    pub fn with_branch(mut self, branch: String) -> Self {
        self.branch = branch;
        self
    }

    /// Set webhook secret (builder pattern)
    pub fn with_webhook_secret(mut self, secret: String) -> Self {
        self.webhook_secret = Some(secret);
        self
    }

    /// Get repository reference, falling back to defaults.
    ///
    /// # Arguments
    ///
    /// * `owner` - Optional owner override
    /// * `repo` - Optional repo override
    ///
    /// # Returns
    ///
    /// Tuple of (owner, repo)
    ///
    /// # Errors
    ///
    /// Returns `GitHubError::MissingSetting` if neither override nor default is available.
    pub fn get_repository_ref(
        &self,
        owner: Option<&str>,
        repo: Option<&str>,
    ) -> Result<(String, String)> {
        let resolved_owner = owner
            .map(|s| s.to_string())
            .or_else(|| self.owner.clone())
            .ok_or_else(|| GitHubError::MissingSetting("owner (GITHUB_OWNER)".to_string()))?;

        let resolved_repo = repo
            .map(|s| s.to_string())
            .or_else(|| self.repo.clone())
            .ok_or_else(|| GitHubError::MissingSetting("repo (GITHUB_REPO)".to_string()))?;

        Ok((resolved_owner, resolved_repo))
    }

    /// Check if GitHub App authentication is configured.
    pub fn has_app_auth(&self) -> bool {
        self.app_id.is_some() && self.app_private_key.is_some()
    }

    /// Validate configuration.
    ///
    /// # Errors
    ///
    /// Returns `GitHubError::ConfigError` if configuration is invalid.
    pub fn validate(&self) -> Result<()> {
        if self.api_token.is_empty() {
            return Err(GitHubError::ConfigError(
                "API token cannot be empty".to_string(),
            ));
        }

        if self.has_app_auth() && self.installation_id.is_none() {
            return Err(GitHubError::ConfigError(
                "GITHUB_INSTALLATION_ID is required when using GitHub App authentication"
                    .to_string(),
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = GitHubConfig::new("test_token".to_string());
        assert_eq!(config.api_token, "test_token");
        assert_eq!(config.branch, "main");
        assert!(config.owner.is_none());
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = GitHubConfig::new("test_token".to_string())
            .with_owner("my-org".to_string())
            .with_repo("my-repo".to_string())
            .with_branch("develop".to_string());

        assert_eq!(config.owner, Some("my-org".to_string()));
        assert_eq!(config.repo, Some("my-repo".to_string()));
        assert_eq!(config.branch, "develop");
    }

    #[test]
    fn test_get_repository_ref() {
        let config = GitHubConfig::new("token".to_string())
            .with_owner("default-owner".to_string())
            .with_repo("default-repo".to_string());

        // Use defaults
        let (owner, repo) = config.get_repository_ref(None, None).unwrap();
        assert_eq!(owner, "default-owner");
        assert_eq!(repo, "default-repo");

        // Override
        let (owner, repo) = config
            .get_repository_ref(Some("other-owner"), Some("other-repo"))
            .unwrap();
        assert_eq!(owner, "other-owner");
        assert_eq!(repo, "other-repo");
    }

    #[test]
    fn test_validate_empty_token() {
        let config = GitHubConfig::new("".to_string());
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_app_auth_without_installation() {
        let mut config = GitHubConfig::new("token".to_string());
        config.app_id = Some("123".to_string());
        config.app_private_key = Some("key".to_string());
        assert!(config.validate().is_err());
    }
}


