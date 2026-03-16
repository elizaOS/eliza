//! Secrets Service implementation.
//!
//! Core service for multi-level secret management in elizaOS.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

use crate::crypto::{is_encrypted_secret, parse_encrypted_secret, KeyManager};
use crate::storage::{CompositeSecretStorage, MemorySecretStorage, SecretStorage};
use crate::types::{
    PluginRequirementStatus, PluginSecretRequirement, SecretAccessLog, SecretConfig,
    SecretContext, SecretLevel, SecretMetadata, SecretPermissionType, SecretsError, SecretsResult,
};
use crate::validation::validate_secret;

/// Type alias for change callback.
pub type SecretChangeCallback = Arc<dyn Fn(&str, Option<&str>, &SecretContext) + Send + Sync>;

/// Secrets Service configuration.
#[derive(Debug, Clone)]
pub struct SecretsServiceConfig {
    /// Enable encryption for stored secrets.
    pub enable_encryption: bool,
    /// Salt for key derivation.
    pub encryption_salt: Option<String>,
    /// Enable access logging.
    pub enable_access_logging: bool,
    /// Maximum number of access log entries.
    pub max_access_log_entries: usize,
}

impl Default for SecretsServiceConfig {
    fn default() -> Self {
        Self {
            enable_encryption: true,
            encryption_salt: None,
            enable_access_logging: true,
            max_access_log_entries: 1000,
        }
    }
}

/// Secrets Service.
///
/// Unified service for managing secrets at all levels:
/// - Global: Agent-wide secrets (API keys, tokens)
/// - World: Server/channel-specific secrets
/// - User: Per-user secrets
pub struct SecretsService {
    agent_id: String,
    config: SecretsServiceConfig,
    key_manager: RwLock<KeyManager>,
    storage: Arc<dyn SecretStorage>,
    access_logs: RwLock<Vec<SecretAccessLog>>,
    key_callbacks: RwLock<HashMap<String, Vec<SecretChangeCallback>>>,
    global_callbacks: RwLock<Vec<SecretChangeCallback>>,
}

impl SecretsService {
    /// Create a new secrets service.
    pub fn new(agent_id: impl Into<String>, config: SecretsServiceConfig) -> Self {
        let agent_id = agent_id.into();

        // Initialize key manager
        let mut key_manager = KeyManager::new();
        let salt = config.encryption_salt.clone().unwrap_or_else(|| "default-salt".to_string());
        key_manager.initialize_from_agent_id(&agent_id, &salt);

        // Create composite storage with memory backends
        let storage = Arc::new(CompositeSecretStorage::new(
            Arc::new(MemorySecretStorage::new()),
            Arc::new(MemorySecretStorage::new()),
            Arc::new(MemorySecretStorage::new()),
        ));

        Self {
            agent_id,
            config,
            key_manager: RwLock::new(key_manager),
            storage,
            access_logs: RwLock::new(Vec::new()),
            key_callbacks: RwLock::new(HashMap::new()),
            global_callbacks: RwLock::new(Vec::new()),
        }
    }

    /// Create with custom storage.
    pub fn with_storage(
        agent_id: impl Into<String>,
        config: SecretsServiceConfig,
        storage: Arc<dyn SecretStorage>,
    ) -> Self {
        let agent_id = agent_id.into();

        let mut key_manager = KeyManager::new();
        let salt = config.encryption_salt.clone().unwrap_or_else(|| "default-salt".to_string());
        key_manager.initialize_from_agent_id(&agent_id, &salt);

        Self {
            agent_id,
            config,
            key_manager: RwLock::new(key_manager),
            storage,
            access_logs: RwLock::new(Vec::new()),
            key_callbacks: RwLock::new(HashMap::new()),
            global_callbacks: RwLock::new(Vec::new()),
        }
    }

    /// Initialize the service.
    pub async fn start(&self) -> SecretsResult<()> {
        self.storage.initialize().await
    }

    /// Stop the service.
    pub async fn stop(&self) -> SecretsResult<()> {
        self.key_manager.write().await.clear();
        self.access_logs.write().await.clear();
        self.key_callbacks.write().await.clear();
        self.global_callbacks.write().await.clear();
        Ok(())
    }

    // ========================================================================
    // Core Secret Operations
    // ========================================================================

    /// Get a secret value.
    pub async fn get(&self, key: &str, context: &SecretContext) -> SecretsResult<Option<String>> {
        self.log_access(key, SecretPermissionType::Read, context, true, None)
            .await;

        let value = self.storage.get(key, context).await?;

        match value {
            None => {
                self.log_access(key, SecretPermissionType::Read, context, false, Some("Secret not found"))
                    .await;
                Ok(None)
            }
            Some(v) => {
                // Decrypt if necessary
                if is_encrypted_secret(&v) {
                    if let Some(encrypted) = parse_encrypted_secret(&v) {
                        let key_manager = self.key_manager.read().await;
                        let plaintext = key_manager.decrypt(&encrypted)?;
                        return Ok(Some(plaintext));
                    }
                }

                // Return as string if not encrypted
                match v {
                    serde_json::Value::String(s) => Ok(Some(s)),
                    other => Ok(Some(other.to_string())),
                }
            }
        }
    }

    /// Set a secret value.
    pub async fn set(
        &self,
        key: &str,
        value: &str,
        context: &SecretContext,
        config: Option<HashMap<String, serde_json::Value>>,
    ) -> SecretsResult<bool> {
        self.log_access(key, SecretPermissionType::Write, context, true, None)
            .await;

        let config_map = config.unwrap_or_default();

        // Validate if validation method specified
        if let Some(serde_json::Value::String(method)) = config_map.get("validationMethod") {
            if method != "none" {
                let validation = validate_secret(key, value, Some(method));
                if !validation.is_valid {
                    self.log_access(
                        key,
                        SecretPermissionType::Write,
                        context,
                        false,
                        validation.error.as_deref(),
                    )
                    .await;
                    return Err(SecretsError::validation_failed(key, validation.error.unwrap_or_default()));
                }
            }
        }

        // Get previous value for change event
        let previous_value = self.get(key, context).await.ok().flatten();

        // Encrypt if enabled
        let stored_value = if self.config.enable_encryption {
            let encrypted = config_map
                .get("encrypted")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            if encrypted {
                let key_manager = self.key_manager.read().await;
                let encrypted_secret = key_manager.encrypt(value)?;
                serde_json::to_value(encrypted_secret).map_err(|e| SecretsError::StorageError {
                    reason: format!("Failed to serialize: {}", e),
                })?
            } else {
                serde_json::Value::String(value.to_string())
            }
        } else {
            serde_json::Value::String(value.to_string())
        };

        // Build config
        let secret_config = self.build_config_from_map(&config_map);

        let success = self
            .storage
            .set(key, stored_value, context, Some(secret_config))
            .await?;

        if success {
            // Emit change event
            self.emit_change_event(key, Some(value), context).await;
        } else {
            self.log_access(key, SecretPermissionType::Write, context, false, Some("Storage operation failed"))
                .await;
        }

        Ok(success)
    }

    /// Delete a secret.
    pub async fn delete(&self, key: &str, context: &SecretContext) -> SecretsResult<bool> {
        self.log_access(key, SecretPermissionType::Delete, context, true, None)
            .await;

        let success = self.storage.delete(key, context).await?;

        if success {
            self.emit_change_event(key, None, context).await;
        } else {
            self.log_access(key, SecretPermissionType::Delete, context, false, Some("Secret not found"))
                .await;
        }

        Ok(success)
    }

    /// Check if a secret exists.
    pub async fn exists(&self, key: &str, context: &SecretContext) -> SecretsResult<bool> {
        self.storage.exists(key, context).await
    }

    /// List secrets (metadata only, no values).
    pub async fn list(&self, context: &SecretContext) -> SecretsResult<SecretMetadata> {
        self.storage.list(context).await
    }

    /// Get secret configuration.
    pub async fn get_config(
        &self,
        key: &str,
        context: &SecretContext,
    ) -> SecretsResult<Option<SecretConfig>> {
        self.storage.get_config(key, context).await
    }

    /// Update secret configuration.
    pub async fn update_config(
        &self,
        key: &str,
        context: &SecretContext,
        config: SecretConfig,
    ) -> SecretsResult<bool> {
        self.storage.update_config(key, context, config).await
    }

    // ========================================================================
    // Convenience Methods
    // ========================================================================

    /// Get a global secret.
    pub async fn get_global(&self, key: &str) -> SecretsResult<Option<String>> {
        let context = SecretContext::global(&self.agent_id);
        self.get(key, &context).await
    }

    /// Set a global secret.
    pub async fn set_global(
        &self,
        key: &str,
        value: &str,
        config: Option<HashMap<String, serde_json::Value>>,
    ) -> SecretsResult<bool> {
        let context = SecretContext::global(&self.agent_id);
        self.set(key, value, &context, config).await
    }

    /// Get a world secret.
    pub async fn get_world(&self, key: &str, world_id: &str) -> SecretsResult<Option<String>> {
        let context = SecretContext::world(&self.agent_id, world_id);
        self.get(key, &context).await
    }

    /// Set a world secret.
    pub async fn set_world(
        &self,
        key: &str,
        value: &str,
        world_id: &str,
        config: Option<HashMap<String, serde_json::Value>>,
    ) -> SecretsResult<bool> {
        let context = SecretContext::world(&self.agent_id, world_id);
        self.set(key, value, &context, config).await
    }

    /// Get a user secret.
    pub async fn get_user(&self, key: &str, user_id: &str) -> SecretsResult<Option<String>> {
        let context = SecretContext::user(&self.agent_id, user_id, Some(user_id.to_string()));
        self.get(key, &context).await
    }

    /// Set a user secret.
    pub async fn set_user(
        &self,
        key: &str,
        value: &str,
        user_id: &str,
        config: Option<HashMap<String, serde_json::Value>>,
    ) -> SecretsResult<bool> {
        let context = SecretContext::user(&self.agent_id, user_id, Some(user_id.to_string()));
        self.set(key, value, &context, config).await
    }

    // ========================================================================
    // Plugin Requirements
    // ========================================================================

    /// Check which secrets are missing for a plugin.
    pub async fn check_plugin_requirements(
        &self,
        plugin_id: &str,
        requirements: &HashMap<String, PluginSecretRequirement>,
    ) -> SecretsResult<PluginRequirementStatus> {
        let mut missing_required = Vec::new();
        let mut missing_optional = Vec::new();
        let mut invalid = Vec::new();

        for (key, requirement) in requirements {
            let value = self.get_global(key).await?;

            if value.is_none() {
                if requirement.required {
                    missing_required.push(key.clone());
                } else {
                    missing_optional.push(key.clone());
                }
                continue;
            }

            // Validate if validation method specified
            if let Some(ref method) = requirement.validation_method {
                if method != "none" {
                    let validation = validate_secret(key, value.as_ref().unwrap(), Some(method));
                    if !validation.is_valid {
                        invalid.push(key.clone());
                    }
                }
            }
        }

        Ok(PluginRequirementStatus::not_ready(
            plugin_id,
            missing_required,
            missing_optional,
            invalid,
        ))
    }

    /// Get missing secrets from a list.
    pub async fn get_missing_secrets(
        &self,
        keys: &[&str],
        level: SecretLevel,
    ) -> SecretsResult<Vec<String>> {
        let mut missing = Vec::new();

        for key in keys {
            let context = match level {
                SecretLevel::Global => SecretContext::global(&self.agent_id),
                SecretLevel::World => {
                    // Default world context
                    SecretContext::world(&self.agent_id, "default")
                }
                SecretLevel::User => {
                    // Default user context
                    SecretContext::user(&self.agent_id, "default", None)
                }
            };

            if !self.exists(key, &context).await? {
                missing.push((*key).to_string());
            }
        }

        Ok(missing)
    }

    // ========================================================================
    // Change Notifications
    // ========================================================================

    /// Register a callback for changes to a specific secret.
    pub async fn on_secret_changed(&self, key: &str, callback: SecretChangeCallback) {
        let mut callbacks = self.key_callbacks.write().await;
        callbacks
            .entry(key.to_string())
            .or_insert_with(Vec::new)
            .push(callback);
    }

    /// Register a callback for all secret changes.
    pub async fn on_any_secret_changed(&self, callback: SecretChangeCallback) {
        let mut callbacks = self.global_callbacks.write().await;
        callbacks.push(callback);
    }

    /// Emit change event to registered callbacks.
    async fn emit_change_event(&self, key: &str, value: Option<&str>, context: &SecretContext) {
        // Key-specific callbacks
        let key_callbacks = self.key_callbacks.read().await;
        if let Some(callbacks) = key_callbacks.get(key) {
            for callback in callbacks {
                callback(key, value, context);
            }
        }

        // Global callbacks
        let global_callbacks = self.global_callbacks.read().await;
        for callback in global_callbacks.iter() {
            callback(key, value, context);
        }
    }

    // ========================================================================
    // Access Logging
    // ========================================================================

    /// Log an access attempt.
    async fn log_access(
        &self,
        key: &str,
        action: SecretPermissionType,
        context: &SecretContext,
        success: bool,
        error: Option<&str>,
    ) {
        if !self.config.enable_access_logging {
            return;
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let accessed_by = context
            .requester_id
            .clone()
            .or_else(|| context.user_id.clone())
            .unwrap_or_else(|| context.agent_id.clone());

        let log_entry = SecretAccessLog {
            secret_key: key.to_string(),
            accessed_by,
            action,
            timestamp: now,
            context: context.clone(),
            success,
            error: error.map(|s| s.to_string()),
        };

        let mut logs = self.access_logs.write().await;
        logs.push(log_entry);

        // Trim if over limit
        if logs.len() > self.config.max_access_log_entries {
            let excess = logs.len() - self.config.max_access_log_entries;
            logs.drain(0..excess);
        }
    }

    /// Get access logs with optional filtering.
    pub async fn get_access_logs(
        &self,
        key: Option<&str>,
        action: Option<SecretPermissionType>,
        since: Option<i64>,
    ) -> Vec<SecretAccessLog> {
        let logs = self.access_logs.read().await;
        logs.iter()
            .filter(|log| key.map_or(true, |k| log.secret_key == k))
            .filter(|log| action.map_or(true, |a| log.action == a))
            .filter(|log| since.map_or(true, |s| log.timestamp >= s))
            .cloned()
            .collect()
    }

    /// Clear access logs.
    pub async fn clear_access_logs(&self) {
        self.access_logs.write().await.clear();
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    fn build_config_from_map(&self, map: &HashMap<String, serde_json::Value>) -> SecretConfig {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        SecretConfig {
            description: map
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            required: map.get("required").and_then(|v| v.as_bool()).unwrap_or(false),
            encrypted: map.get("encrypted").and_then(|v| v.as_bool()).unwrap_or(true),
            created_at: Some(now),
            updated_at: Some(now),
            ..Default::default()
        }
    }

    /// Get the key manager.
    pub async fn get_key_manager(&self) -> tokio::sync::RwLockReadGuard<'_, KeyManager> {
        self.key_manager.read().await
    }

    /// Get the agent ID.
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_service_basic() {
        let service = SecretsService::new("agent-123", SecretsServiceConfig::default());
        service.start().await.unwrap();

        let context = SecretContext::global("agent-123");

        // Set a secret
        service.set("TEST_KEY", "secret_value", &context, None).await.unwrap();

        // Get the secret
        let value = service.get("TEST_KEY", &context).await.unwrap();
        assert_eq!(value, Some("secret_value".to_string()));

        // Check exists
        assert!(service.exists("TEST_KEY", &context).await.unwrap());

        // Delete
        service.delete("TEST_KEY", &context).await.unwrap();
        assert!(!service.exists("TEST_KEY", &context).await.unwrap());

        service.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_service_convenience_methods() {
        let service = SecretsService::new("agent-123", SecretsServiceConfig::default());
        service.start().await.unwrap();

        // Global
        service.set_global("GLOBAL_KEY", "global_value", None).await.unwrap();
        assert_eq!(
            service.get_global("GLOBAL_KEY").await.unwrap(),
            Some("global_value".to_string())
        );

        // World
        service.set_world("WORLD_KEY", "world_value", "world-456", None).await.unwrap();
        assert_eq!(
            service.get_world("WORLD_KEY", "world-456").await.unwrap(),
            Some("world_value".to_string())
        );

        // User
        service.set_user("USER_KEY", "user_value", "user-789", None).await.unwrap();
        assert_eq!(
            service.get_user("USER_KEY", "user-789").await.unwrap(),
            Some("user_value".to_string())
        );

        service.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_service_validation() {
        let service = SecretsService::new("agent-123", SecretsServiceConfig::default());
        service.start().await.unwrap();

        let context = SecretContext::global("agent-123");

        // Valid OpenAI key
        let mut config = HashMap::new();
        config.insert(
            "validationMethod".to_string(),
            serde_json::json!("openai"),
        );

        let result = service
            .set("OPENAI_API_KEY", "sk-abc123def456ghi789jkl", &context, Some(config.clone()))
            .await;
        assert!(result.is_ok());

        // Invalid OpenAI key
        let result = service.set("OPENAI_API_KEY", "invalid", &context, Some(config)).await;
        assert!(result.is_err());

        service.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_service_plugin_requirements() {
        let service = SecretsService::new("agent-123", SecretsServiceConfig::default());
        service.start().await.unwrap();

        // Set one secret
        service.set_global("KEY1", "value1", None).await.unwrap();

        let mut requirements = HashMap::new();
        requirements.insert(
            "KEY1".to_string(),
            PluginSecretRequirement::required("KEY1", "First key"),
        );
        requirements.insert(
            "KEY2".to_string(),
            PluginSecretRequirement::required("KEY2", "Second key"),
        );
        requirements.insert(
            "KEY3".to_string(),
            PluginSecretRequirement::optional("KEY3", "Third key"),
        );

        let status = service
            .check_plugin_requirements("test-plugin", &requirements)
            .await
            .unwrap();

        assert!(!status.ready);
        assert_eq!(status.missing_required, vec!["KEY2"]);
        assert_eq!(status.missing_optional, vec!["KEY3"]);

        service.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_service_access_logs() {
        let service = SecretsService::new("agent-123", SecretsServiceConfig::default());
        service.start().await.unwrap();

        let context = SecretContext::global("agent-123");

        service.set("TEST_KEY", "value", &context, None).await.unwrap();
        service.get("TEST_KEY", &context).await.unwrap();
        service.delete("TEST_KEY", &context).await.unwrap();

        let logs = service.get_access_logs(None, None, None).await;
        assert!(logs.len() >= 3);

        let write_logs = service
            .get_access_logs(Some("TEST_KEY"), Some(SecretPermissionType::Write), None)
            .await;
        assert!(!write_logs.is_empty());

        service.clear_access_logs().await;
        let logs = service.get_access_logs(None, None, None).await;
        assert!(logs.is_empty());

        service.stop().await.unwrap();
    }
}
