//! Core types for elizaOS Secrets Manager.
//!
//! Defines all type definitions for multi-level secret management.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Secret storage level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretLevel {
    /// Agent-wide secrets (API keys, tokens)
    Global,
    /// Server/channel-specific secrets
    World,
    /// Per-user secrets
    User,
}

impl Default for SecretLevel {
    fn default() -> Self {
        Self::Global
    }
}

/// Types of secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretType {
    ApiKey,
    Token,
    Password,
    Credential,
    Url,
    Custom,
}

impl Default for SecretType {
    fn default() -> Self {
        Self::ApiKey
    }
}

/// Status of a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretStatus {
    Set,
    NotSet,
    Invalid,
    Expired,
}

impl Default for SecretStatus {
    fn default() -> Self {
        Self::NotSet
    }
}

/// Storage backend type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageBackend {
    Memory,
    Character,
    World,
    Component,
}

impl Default for StorageBackend {
    fn default() -> Self {
        Self::Memory
    }
}

/// Permission types for secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretPermissionType {
    Read,
    Write,
    Delete,
    List,
    Admin,
}

/// Secret configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretConfig {
    /// Human-readable description
    pub description: Option<String>,
    /// Whether this secret is required
    pub required: bool,
    /// Type of secret
    #[serde(rename = "type")]
    pub secret_type: SecretType,
    /// Validation method
    pub validation_method: Option<String>,
    /// Environment variable to sync to
    pub env_var: Option<String>,
    /// Whether value is encrypted
    pub encrypted: bool,
    /// Creation timestamp (ms)
    pub created_at: Option<i64>,
    /// Last update timestamp (ms)
    pub updated_at: Option<i64>,
    /// TTL in milliseconds
    pub expires_in: Option<i64>,
    /// Whether to redact in logs
    pub redact_in_logs: bool,
    /// Rotation policy
    pub rotation_policy: Option<String>,
    /// Tags for categorization
    pub tags: Vec<String>,
}

impl Default for SecretConfig {
    fn default() -> Self {
        Self {
            description: None,
            required: false,
            secret_type: SecretType::default(),
            validation_method: None,
            env_var: None,
            encrypted: true,
            created_at: None,
            updated_at: None,
            expires_in: None,
            redact_in_logs: true,
            rotation_policy: None,
            tags: Vec::new(),
        }
    }
}

/// Context for secret operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretContext {
    /// Storage level
    pub level: SecretLevel,
    /// Agent ID (always required)
    pub agent_id: String,
    /// World ID (required for world/user level)
    pub world_id: Option<String>,
    /// User ID (required for user level)
    pub user_id: Option<String>,
    /// Room ID for context
    pub room_id: Option<String>,
    /// ID of the requester
    pub requester_id: Option<String>,
}

impl SecretContext {
    /// Create a global context.
    pub fn global(agent_id: impl Into<String>) -> Self {
        Self {
            level: SecretLevel::Global,
            agent_id: agent_id.into(),
            world_id: None,
            user_id: None,
            room_id: None,
            requester_id: None,
        }
    }

    /// Create a world context.
    pub fn world(agent_id: impl Into<String>, world_id: impl Into<String>) -> Self {
        Self {
            level: SecretLevel::World,
            agent_id: agent_id.into(),
            world_id: Some(world_id.into()),
            user_id: None,
            room_id: None,
            requester_id: None,
        }
    }

    /// Create a user context.
    pub fn user(
        agent_id: impl Into<String>,
        user_id: impl Into<String>,
        requester_id: Option<String>,
    ) -> Self {
        Self {
            level: SecretLevel::User,
            agent_id: agent_id.into(),
            world_id: None,
            user_id: Some(user_id.into()),
            room_id: None,
            requester_id,
        }
    }
}

/// Metadata about stored secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMetadata {
    /// List of secret keys
    pub keys: Vec<String>,
    /// Configurations per key
    pub configs: HashMap<String, SecretConfig>,
    /// Total count
    pub count: usize,
    /// Last modified timestamp
    pub last_modified: Option<i64>,
}

impl Default for SecretMetadata {
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            configs: HashMap::new(),
            count: 0,
            last_modified: None,
        }
    }
}

/// Encrypted secret structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSecret {
    /// Encrypted ciphertext (base64)
    pub ciphertext: String,
    /// Initialization vector (base64)
    pub iv: String,
    /// Authentication tag for GCM (base64)
    pub auth_tag: Option<String>,
    /// Key ID used for encryption
    pub key_id: String,
    /// Algorithm used
    pub algorithm: String,
    /// Version for future migrations
    pub version: u32,
}

impl EncryptedSecret {
    /// Check if this is a valid encrypted secret structure.
    pub fn is_valid(&self) -> bool {
        !self.ciphertext.is_empty() && !self.iv.is_empty() && !self.key_id.is_empty()
    }
}

/// Access log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretAccessLog {
    /// Secret key accessed
    pub secret_key: String,
    /// Who accessed it
    pub accessed_by: String,
    /// Type of action
    pub action: SecretPermissionType,
    /// Timestamp (ms)
    pub timestamp: i64,
    /// Context of access
    pub context: SecretContext,
    /// Whether access was successful
    pub success: bool,
    /// Error message if failed
    pub error: Option<String>,
}

/// Plugin secret requirement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSecretRequirement {
    /// Secret key name
    pub key: String,
    /// Human-readable description
    pub description: String,
    /// Whether this secret is required
    pub required: bool,
    /// Type of secret expected
    pub secret_type: SecretType,
    /// Validation method to use
    pub validation_method: Option<String>,
    /// Default value if not set
    pub default_value: Option<String>,
    /// Environment variable alternative
    pub env_var: Option<String>,
}

impl PluginSecretRequirement {
    /// Create a required secret requirement.
    pub fn required(key: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            description: description.into(),
            required: true,
            secret_type: SecretType::ApiKey,
            validation_method: None,
            default_value: None,
            env_var: None,
        }
    }

    /// Create an optional secret requirement.
    pub fn optional(key: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            description: description.into(),
            required: false,
            secret_type: SecretType::ApiKey,
            validation_method: None,
            default_value: None,
            env_var: None,
        }
    }

    /// Set the validation method.
    pub fn with_validation(mut self, method: impl Into<String>) -> Self {
        self.validation_method = Some(method.into());
        self
    }

    /// Set the environment variable.
    pub fn with_env_var(mut self, env_var: impl Into<String>) -> Self {
        self.env_var = Some(env_var.into());
        self
    }
}

/// Status of plugin secret requirements.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequirementStatus {
    /// Plugin ID
    pub plugin_id: String,
    /// Whether all required secrets are available
    pub ready: bool,
    /// Missing required secrets
    pub missing_required: Vec<String>,
    /// Missing optional secrets
    pub missing_optional: Vec<String>,
    /// Secrets that failed validation
    pub invalid: Vec<String>,
    /// Human-readable message
    pub message: String,
}

impl PluginRequirementStatus {
    /// Create a ready status.
    pub fn ready(plugin_id: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            ready: true,
            missing_required: Vec::new(),
            missing_optional: Vec::new(),
            invalid: Vec::new(),
            message: "Ready".to_string(),
        }
    }

    /// Create a not-ready status.
    pub fn not_ready(
        plugin_id: impl Into<String>,
        missing_required: Vec<String>,
        missing_optional: Vec<String>,
        invalid: Vec<String>,
    ) -> Self {
        let mut message_parts = Vec::new();
        if !missing_required.is_empty() {
            message_parts.push(format!("Missing: {}", missing_required.join(", ")));
        }
        if !invalid.is_empty() {
            message_parts.push(format!("Invalid: {}", invalid.join(", ")));
        }
        let message = if message_parts.is_empty() {
            "Ready".to_string()
        } else {
            message_parts.join("; ")
        };

        Self {
            plugin_id: plugin_id.into(),
            ready: missing_required.is_empty() && invalid.is_empty(),
            missing_required,
            missing_optional,
            invalid,
            message,
        }
    }
}

/// Secret change event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretChangeEvent {
    /// Event type
    pub event_type: SecretChangeType,
    /// Secret key
    pub key: String,
    /// Context of change
    pub context: SecretContext,
    /// Timestamp (ms)
    pub timestamp: i64,
    /// Previous value (masked)
    pub previous_masked: Option<String>,
    /// New value (masked)
    pub new_masked: Option<String>,
}

/// Type of secret change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretChangeType {
    Created,
    Updated,
    Deleted,
}

/// Errors that can occur in secrets management.
#[derive(Debug, Error)]
pub enum SecretsError {
    #[error("Secret not found: {key}")]
    NotFound { key: String },

    #[error("Permission denied: {action} on {key}")]
    PermissionDenied { key: String, action: String },

    #[error("Validation failed for {key}: {reason}")]
    ValidationFailed { key: String, reason: String },

    #[error("Encryption failed: {reason}")]
    EncryptionFailed { reason: String },

    #[error("Decryption failed: {reason}")]
    DecryptionFailed { reason: String },

    #[error("Storage error: {reason}")]
    StorageError { reason: String },

    #[error("Configuration error: {reason}")]
    ConfigError { reason: String },

    #[error("Invalid context: {reason}")]
    InvalidContext { reason: String },

    #[error("Key not found: {key_id}")]
    KeyNotFound { key_id: String },
}

impl SecretsError {
    /// Create a not found error.
    pub fn not_found(key: impl Into<String>) -> Self {
        Self::NotFound { key: key.into() }
    }

    /// Create a permission denied error.
    pub fn permission_denied(key: impl Into<String>, action: impl Into<String>) -> Self {
        Self::PermissionDenied {
            key: key.into(),
            action: action.into(),
        }
    }

    /// Create a validation failed error.
    pub fn validation_failed(key: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::ValidationFailed {
            key: key.into(),
            reason: reason.into(),
        }
    }
}

/// Result type for secrets operations.
pub type SecretsResult<T> = Result<T, SecretsError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_context_global() {
        let ctx = SecretContext::global("agent-123");
        assert_eq!(ctx.level, SecretLevel::Global);
        assert_eq!(ctx.agent_id, "agent-123");
        assert!(ctx.world_id.is_none());
        assert!(ctx.user_id.is_none());
    }

    #[test]
    fn test_secret_context_world() {
        let ctx = SecretContext::world("agent-123", "world-456");
        assert_eq!(ctx.level, SecretLevel::World);
        assert_eq!(ctx.agent_id, "agent-123");
        assert_eq!(ctx.world_id, Some("world-456".to_string()));
    }

    #[test]
    fn test_secret_context_user() {
        let ctx = SecretContext::user("agent-123", "user-789", Some("requester-000".to_string()));
        assert_eq!(ctx.level, SecretLevel::User);
        assert_eq!(ctx.agent_id, "agent-123");
        assert_eq!(ctx.user_id, Some("user-789".to_string()));
        assert_eq!(ctx.requester_id, Some("requester-000".to_string()));
    }

    #[test]
    fn test_plugin_requirement_builder() {
        let req = PluginSecretRequirement::required("OPENAI_API_KEY", "OpenAI API key")
            .with_validation("openai")
            .with_env_var("OPENAI_API_KEY");

        assert!(req.required);
        assert_eq!(req.key, "OPENAI_API_KEY");
        assert_eq!(req.validation_method, Some("openai".to_string()));
        assert_eq!(req.env_var, Some("OPENAI_API_KEY".to_string()));
    }

    #[test]
    fn test_plugin_requirement_status() {
        let status = PluginRequirementStatus::not_ready(
            "test-plugin",
            vec!["KEY1".to_string()],
            vec!["KEY2".to_string()],
            vec![],
        );

        assert!(!status.ready);
        assert_eq!(status.missing_required, vec!["KEY1"]);
        assert_eq!(status.missing_optional, vec!["KEY2"]);
        assert!(status.message.contains("Missing"));
    }

    #[test]
    fn test_secret_config_default() {
        let config = SecretConfig::default();
        assert!(config.encrypted);
        assert!(!config.required);
        assert!(config.redact_in_logs);
    }
}
