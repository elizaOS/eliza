//! Configuration types and helpers for the MS Teams plugin.

use serde::{Deserialize, Serialize};

use crate::error::{MSTeamsError, Result};

/// Configuration options for the MS Teams plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MSTeamsConfig {
    /// Bot App ID from Azure Bot registration.
    pub app_id: String,
    /// Bot App Password/Secret from Azure Bot registration.
    pub app_password: String,
    /// Azure AD Tenant ID.
    pub tenant_id: String,
    /// Whether the plugin is enabled.
    pub enabled: bool,
    /// Webhook server port (default: 3978).
    pub webhook_port: u16,
    /// Webhook endpoint path (default: /api/messages).
    pub webhook_path: String,
    /// Allowed tenant IDs for multi-tenant bots.
    pub allowed_tenants: Vec<String>,
    /// SharePoint site ID for file uploads.
    pub sharepoint_site_id: Option<String>,
    /// Maximum media file size in MB.
    pub media_max_mb: u32,
}

impl MSTeamsConfig {
    /// Creates a new config with the required credentials.
    pub fn new(app_id: String, app_password: String, tenant_id: String) -> Self {
        Self {
            app_id,
            app_password,
            tenant_id,
            enabled: true,
            webhook_port: 3978,
            webhook_path: "/api/messages".to_string(),
            allowed_tenants: Vec::new(),
            sharepoint_site_id: None,
            media_max_mb: 100,
        }
    }

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `MSTEAMS_APP_ID`
    /// - `MSTEAMS_APP_PASSWORD`
    /// - `MSTEAMS_TENANT_ID`
    ///
    /// Optional:
    /// - `MSTEAMS_ENABLED` (default: true)
    /// - `MSTEAMS_WEBHOOK_PORT` (default: 3978)
    /// - `MSTEAMS_WEBHOOK_PATH` (default: /api/messages)
    /// - `MSTEAMS_ALLOWED_TENANTS` (JSON array)
    /// - `MSTEAMS_SHAREPOINT_SITE_ID`
    /// - `MSTEAMS_MEDIA_MAX_MB` (default: 100)
    pub fn from_env() -> Result<Self> {
        let app_id = std::env::var("MSTEAMS_APP_ID")
            .map_err(|_| MSTeamsError::MissingSetting("MSTEAMS_APP_ID".to_string()))?;

        let app_password = std::env::var("MSTEAMS_APP_PASSWORD")
            .map_err(|_| MSTeamsError::MissingSetting("MSTEAMS_APP_PASSWORD".to_string()))?;

        let tenant_id = std::env::var("MSTEAMS_TENANT_ID")
            .map_err(|_| MSTeamsError::MissingSetting("MSTEAMS_TENANT_ID".to_string()))?;

        if app_id.is_empty() {
            return Err(MSTeamsError::ConfigError(
                "MSTEAMS_APP_ID cannot be empty".to_string(),
            ));
        }

        if app_password.is_empty() {
            return Err(MSTeamsError::ConfigError(
                "MSTEAMS_APP_PASSWORD cannot be empty".to_string(),
            ));
        }

        if tenant_id.is_empty() {
            return Err(MSTeamsError::ConfigError(
                "MSTEAMS_TENANT_ID cannot be empty".to_string(),
            ));
        }

        let enabled = std::env::var("MSTEAMS_ENABLED")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        let webhook_port = std::env::var("MSTEAMS_WEBHOOK_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3978);

        let webhook_path = std::env::var("MSTEAMS_WEBHOOK_PATH")
            .unwrap_or_else(|_| "/api/messages".to_string());

        let allowed_tenants = std::env::var("MSTEAMS_ALLOWED_TENANTS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let sharepoint_site_id = std::env::var("MSTEAMS_SHAREPOINT_SITE_ID").ok();

        let media_max_mb = std::env::var("MSTEAMS_MEDIA_MAX_MB")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(100);

        Ok(Self {
            app_id,
            app_password,
            tenant_id,
            enabled,
            webhook_port,
            webhook_path,
            allowed_tenants,
            sharepoint_site_id,
            media_max_mb,
        })
    }

    /// Sets the webhook port.
    pub fn with_webhook_port(mut self, port: u16) -> Self {
        self.webhook_port = port;
        self
    }

    /// Sets the webhook path.
    pub fn with_webhook_path(mut self, path: String) -> Self {
        self.webhook_path = path;
        self
    }

    /// Sets the allowed tenant IDs.
    pub fn with_allowed_tenants(mut self, tenants: Vec<String>) -> Self {
        self.allowed_tenants = tenants;
        self
    }

    /// Sets the SharePoint site ID.
    pub fn with_sharepoint_site_id(mut self, site_id: String) -> Self {
        self.sharepoint_site_id = Some(site_id);
        self
    }

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<()> {
        if self.app_id.is_empty() {
            return Err(MSTeamsError::ConfigError(
                "App ID cannot be empty".to_string(),
            ));
        }

        if self.app_password.is_empty() {
            return Err(MSTeamsError::ConfigError(
                "App Password cannot be empty".to_string(),
            ));
        }

        if self.tenant_id.is_empty() {
            return Err(MSTeamsError::ConfigError(
                "Tenant ID cannot be empty".to_string(),
            ));
        }

        Ok(())
    }

    /// Returns `true` if the given tenant ID is allowed by the configuration.
    pub fn is_tenant_allowed(&self, tenant_id: &str) -> bool {
        self.allowed_tenants.is_empty() || self.allowed_tenants.contains(&tenant_id.to_string())
    }
}

/// MS Teams credentials for authentication.
#[derive(Debug, Clone)]
pub struct MSTeamsCredentials {
    /// Bot App ID.
    pub app_id: String,
    /// Bot App Password.
    pub app_password: String,
    /// Azure AD Tenant ID.
    pub tenant_id: String,
}

impl From<&MSTeamsConfig> for MSTeamsCredentials {
    fn from(config: &MSTeamsConfig) -> Self {
        Self {
            app_id: config.app_id.clone(),
            app_password: config.app_password.clone(),
            tenant_id: config.tenant_id.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = MSTeamsConfig::new(
            "app-id".to_string(),
            "app-password".to_string(),
            "tenant-id".to_string(),
        );
        assert_eq!(config.app_id, "app-id");
        assert_eq!(config.webhook_port, 3978);
        assert!(config.enabled);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = MSTeamsConfig::new(
            "app-id".to_string(),
            "app-password".to_string(),
            "tenant-id".to_string(),
        )
        .with_webhook_port(8080)
        .with_allowed_tenants(vec!["tenant1".to_string(), "tenant2".to_string()]);

        assert_eq!(config.webhook_port, 8080);
        assert_eq!(config.allowed_tenants.len(), 2);
    }

    #[test]
    fn test_is_tenant_allowed() {
        let config = MSTeamsConfig::new(
            "app-id".to_string(),
            "app-password".to_string(),
            "tenant-id".to_string(),
        )
        .with_allowed_tenants(vec!["tenant1".to_string(), "tenant2".to_string()]);

        assert!(config.is_tenant_allowed("tenant1"));
        assert!(config.is_tenant_allowed("tenant2"));
        assert!(!config.is_tenant_allowed("tenant3"));

        // Empty allowed list = all allowed
        let config_all = MSTeamsConfig::new(
            "app-id".to_string(),
            "app-password".to_string(),
            "tenant-id".to_string(),
        );
        assert!(config_all.is_tenant_allowed("any-tenant"));
    }

    #[test]
    fn test_validate_valid() {
        let config = MSTeamsConfig::new(
            "app-id".to_string(),
            "app-password".to_string(),
            "tenant-id".to_string(),
        );
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_invalid() {
        let config = MSTeamsConfig::new("".to_string(), "password".to_string(), "tenant".to_string());
        assert!(config.validate().is_err());
    }
}
