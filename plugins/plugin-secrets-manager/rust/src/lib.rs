//! elizaOS Secrets Manager Plugin
//!
//! Multi-level secrets management with encryption, validation, and dynamic plugin activation.
//!
//! # Overview
//!
//! This crate provides a comprehensive secrets management solution for elizaOS agents:
//!
//! - **Multi-level storage**: Global (agent-wide), World (server/channel), and User (per-user) secrets
//! - **Strong encryption**: AES-256-GCM encryption with secure key derivation
//! - **Validation**: Built-in validators for common API keys (OpenAI, Anthropic, etc.)
//! - **Dynamic activation**: Plugins can be activated once their required secrets are available
//! - **Access logging**: Track who accessed what secrets and when
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_secrets_manager::{
//!     SecretsService, SecretsServiceConfig, SecretContext
//! };
//!
//! #[tokio::main]
//! async fn main() {
//!     // Create the service
//!     let service = SecretsService::new("agent-123", SecretsServiceConfig::default());
//!     service.start().await.unwrap();
//!
//!     // Set a global secret
//!     service.set_global("OPENAI_API_KEY", "sk-...", None).await.unwrap();
//!
//!     // Get the secret
//!     let key = service.get_global("OPENAI_API_KEY").await.unwrap();
//!     println!("API Key: {:?}", key);
//!
//!     service.stop().await.unwrap();
//! }
//! ```

pub mod crypto;
pub mod service;
pub mod storage;
pub mod types;
pub mod validation;

// Re-export main types
pub use crypto::{
    decrypt, derive_key_from_agent_id, encrypt, generate_key, generate_salt, hash_value,
    is_encrypted_secret, mask_secret, parse_encrypted_secret, secure_compare, KeyManager,
    ALGORITHM_AES_GCM, ENCRYPTION_VERSION,
};

pub use service::{SecretChangeCallback, SecretsService, SecretsServiceConfig};

pub use storage::{
    CompositeSecretStorage, MemorySecretStorage, SecretStorage, StorageEntry,
};

pub use types::{
    EncryptedSecret, PluginRequirementStatus, PluginSecretRequirement, SecretAccessLog,
    SecretChangeEvent, SecretChangeType, SecretConfig, SecretContext, SecretLevel,
    SecretMetadata, SecretPermissionType, SecretStatus, SecretType, SecretsError, SecretsResult,
    StorageBackend,
};

pub use validation::{
    get_validator, infer_validation_strategy, register_validator, validate_secret,
    ValidationResult,
};

/// Plugin information.
pub const PLUGIN_NAME: &str = "secrets-manager";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PLUGIN_DESCRIPTION: &str =
    "Multi-level secrets management with encryption and dynamic plugin activation";

/// Service type identifier.
pub const SECRETS_SERVICE_TYPE: &str = "SECRETS";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_info() {
        assert_eq!(PLUGIN_NAME, "secrets-manager");
        assert!(!PLUGIN_VERSION.is_empty());
    }

    #[tokio::test]
    async fn test_integration() {
        // Create service
        let service = SecretsService::new("test-agent", SecretsServiceConfig::default());
        service.start().await.unwrap();

        // Test global secrets
        service.set_global("API_KEY", "test-value", None).await.unwrap();
        let value = service.get_global("API_KEY").await.unwrap();
        assert_eq!(value, Some("test-value".to_string()));

        // Test world secrets
        service.set_world("WORLD_SECRET", "world-value", "world-1", None).await.unwrap();
        let value = service.get_world("WORLD_SECRET", "world-1").await.unwrap();
        assert_eq!(value, Some("world-value".to_string()));

        // Test user secrets
        service.set_user("USER_SECRET", "user-value", "user-1", None).await.unwrap();
        let value = service.get_user("USER_SECRET", "user-1").await.unwrap();
        assert_eq!(value, Some("user-value".to_string()));

        // Test isolation
        assert!(service.get_world("WORLD_SECRET", "world-2").await.unwrap().is_none());
        assert!(service.get_user("USER_SECRET", "user-2").await.unwrap().is_none());

        service.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_encryption_roundtrip() {
        // Test that encryption/decryption works correctly through the service
        let service = SecretsService::new("encrypt-test", SecretsServiceConfig::default());
        service.start().await.unwrap();

        let secret_value = "super-secret-api-key-12345";
        service.set_global("ENCRYPTED_KEY", secret_value, None).await.unwrap();

        let retrieved = service.get_global("ENCRYPTED_KEY").await.unwrap();
        assert_eq!(retrieved, Some(secret_value.to_string()));

        service.stop().await.unwrap();
    }
}
