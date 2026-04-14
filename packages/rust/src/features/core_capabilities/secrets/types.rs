//! Secrets Manager types — Rust port of the TypeScript plugin-secrets-manager types.

use serde::{Deserialize, Serialize};

// ============================================================================
// Constants
// ============================================================================

/// Maximum length of a secret key.
pub const SECRET_KEY_MAX_LENGTH: usize = 256;
/// Maximum length of a secret value.
pub const SECRET_VALUE_MAX_LENGTH: usize = 65536;
/// Maximum length of a secret description.
pub const SECRET_DESCRIPTION_MAX_LENGTH: usize = 1024;
/// Maximum number of access log entries to retain.
pub const MAX_ACCESS_LOG_ENTRIES: usize = 1000;

// ============================================================================
// Enums
// ============================================================================

/// Storage level for secrets.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum SecretLevel {
    Global,
    World,
    User,
}

/// Type classification of a secret.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretType {
    ApiKey,
    PrivateKey,
    PublicKey,
    Url,
    Credential,
    Token,
    Config,
    Secret,
}

/// Current status of a secret.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecretStatus {
    Missing,
    Generating,
    Validating,
    Invalid,
    Valid,
    Expired,
    Revoked,
}

/// Permission type for secret operations.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecretPermissionType {
    Read,
    Write,
    Delete,
    Share,
}

/// Validation strategy for secrets.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ValidationStrategy {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "api_key:openai")]
    ApiKeyOpenai,
    #[serde(rename = "api_key:anthropic")]
    ApiKeyAnthropic,
    #[serde(rename = "api_key:groq")]
    ApiKeyGroq,
    #[serde(rename = "api_key:google")]
    ApiKeyGoogle,
    #[serde(rename = "api_key:mistral")]
    ApiKeyMistral,
    #[serde(rename = "api_key:cohere")]
    ApiKeyCohere,
    #[serde(rename = "url:valid")]
    UrlValid,
    #[serde(rename = "url:reachable")]
    UrlReachable,
    #[serde(rename = "custom")]
    Custom,
}

/// Storage backend type.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StorageBackend {
    Memory,
    Character,
    World,
    Component,
}

// ============================================================================
// Core Secret Types
// ============================================================================

/// Configuration for a single secret.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretConfig {
    #[serde(rename = "type")]
    pub secret_type: SecretType,
    pub required: bool,
    pub description: String,
    pub can_generate: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_method: Option<ValidationStrategy>,
    pub status: SecretStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validated_at: Option<i64>,
    pub plugin: String,
    pub level: SecretLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_id: Option<String>,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Vec<SecretPermission>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_with: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// Context for secret operations.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretContext {
    pub level: SecretLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_id: Option<String>,
}

/// Permission grant for a secret.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretPermission {
    pub entity_id: String,
    pub permissions: Vec<SecretPermissionType>,
    pub granted_by: String,
    pub granted_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// Access log entry for auditing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretAccessLog {
    pub secret_key: String,
    pub accessed_by: String,
    pub action: SecretPermissionType,
    pub timestamp: i64,
    pub context: SecretContext,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Encryption Types
// ============================================================================

/// Encrypted secret container.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSecret {
    /// Encrypted value (base64).
    pub value: String,
    /// Initialization vector (base64).
    pub iv: String,
    /// Authentication tag for GCM mode (base64).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_tag: Option<String>,
    /// Encryption algorithm used.
    pub algorithm: EncryptionAlgorithm,
    /// Key identifier for key rotation.
    pub key_id: String,
}

/// Supported encryption algorithms.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum EncryptionAlgorithm {
    #[serde(rename = "aes-256-gcm")]
    Aes256Gcm,
    #[serde(rename = "aes-256-cbc")]
    Aes256Cbc,
}

/// Key derivation parameters.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDerivationParams {
    /// Salt for key derivation (base64).
    pub salt: String,
    /// Number of iterations for PBKDF2.
    pub iterations: u32,
    /// Algorithm used for derivation.
    pub algorithm: KeyDerivationAlgorithm,
    /// Key length in bytes.
    pub key_length: usize,
}

/// Supported key derivation algorithms.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum KeyDerivationAlgorithm {
    #[serde(rename = "pbkdf2-sha256")]
    Pbkdf2Sha256,
    #[serde(rename = "argon2id")]
    Argon2id,
}

// ============================================================================
// Validation Types
// ============================================================================

/// Result of secret validation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub is_valid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    pub validated_at: i64,
}

// ============================================================================
// Plugin Activation Types
// ============================================================================

/// Secret requirement declared by a plugin.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSecretRequirement {
    pub description: String,
    #[serde(rename = "type")]
    pub secret_type: SecretType,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_method: Option<ValidationStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_var: Option<String>,
    #[serde(default)]
    pub can_generate: bool,
}

/// Status of plugin requirements.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequirementStatus {
    pub plugin_id: String,
    pub ready: bool,
    pub missing_required: Vec<String>,
    pub missing_optional: Vec<String>,
    pub invalid: Vec<String>,
    pub message: String,
}

// ============================================================================
// Service Configuration
// ============================================================================

/// Secrets service configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsServiceConfig {
    pub enable_encryption: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_salt: Option<String>,
    pub enable_access_logging: bool,
    pub max_access_log_entries: usize,
}

impl Default for SecretsServiceConfig {
    fn default() -> Self {
        Self {
            enable_encryption: false,
            encryption_salt: None,
            enable_access_logging: true,
            max_access_log_entries: MAX_ACCESS_LOG_ENTRIES,
        }
    }
}

// ============================================================================
// Event Types
// ============================================================================

/// Secret change event type.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecretChangeType {
    Created,
    Updated,
    Deleted,
    Expired,
}

/// Secret change event.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretChangeEvent {
    #[serde(rename = "type")]
    pub change_type: SecretChangeType,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_value: Option<String>,
    pub context: SecretContext,
    pub timestamp: i64,
}
