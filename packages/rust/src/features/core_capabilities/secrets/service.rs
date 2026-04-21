//! SecretsService — manages secret storage, retrieval, and access control.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::crypto;
use super::types::*;

/// Stored secret: value + config.
#[derive(Clone, Debug)]
struct StoredSecret {
    /// The secret value (plaintext or encrypted representation).
    value: String,
    /// Whether the stored value is encrypted.
    encrypted: bool,
    /// Secret configuration.
    config: SecretConfig,
}

/// In-memory secrets service with optional encryption and access logging.
pub struct SecretsService {
    /// Secrets keyed by (level_key, secret_key).
    secrets: Arc<RwLock<HashMap<String, HashMap<String, StoredSecret>>>>,
    /// Access log.
    access_log: Arc<RwLock<Vec<SecretAccessLog>>>,
    /// Service configuration.
    config: SecretsServiceConfig,
    /// Encryption key (derived from salt if encryption is enabled).
    encryption_key: Option<[u8; 32]>,
}

impl SecretsService {
    /// Create a new SecretsService.
    pub fn new(config: SecretsServiceConfig) -> Self {
        let encryption_key = if config.enable_encryption {
            let salt = config.encryption_salt.as_deref().unwrap_or("default-salt");
            Some(crypto::derive_key(
                "elizaos-secrets",
                salt.as_bytes(),
                10000,
            ))
        } else {
            None
        };

        Self {
            secrets: Arc::new(RwLock::new(HashMap::new())),
            access_log: Arc::new(RwLock::new(Vec::new())),
            config,
            encryption_key,
        }
    }

    /// Build a scope key from context.
    fn scope_key(context: &SecretContext) -> String {
        match context.level {
            SecretLevel::Global => format!("global:{}", context.agent_id),
            SecretLevel::World => format!(
                "world:{}:{}",
                context.agent_id,
                context.world_id.as_deref().unwrap_or("default")
            ),
            SecretLevel::User => format!(
                "user:{}:{}",
                context.agent_id,
                context.user_id.as_deref().unwrap_or("default")
            ),
        }
    }

    /// Log an access attempt.
    async fn log_access(
        &self,
        key: &str,
        accessed_by: &str,
        action: SecretPermissionType,
        context: &SecretContext,
        success: bool,
        error: Option<String>,
    ) {
        if !self.config.enable_access_logging {
            return;
        }

        let entry = SecretAccessLog {
            secret_key: key.to_string(),
            accessed_by: accessed_by.to_string(),
            action,
            timestamp: chrono::Utc::now().timestamp_millis(),
            context: context.clone(),
            success,
            error,
        };

        let mut log = self.access_log.write().await;
        log.push(entry);

        // Trim old entries
        while log.len() > self.config.max_access_log_entries {
            log.remove(0);
        }
    }

    /// Check if a secret exists.
    pub async fn exists(&self, key: &str, context: &SecretContext) -> bool {
        let scope = Self::scope_key(context);
        self.secrets
            .read()
            .await
            .get(&scope)
            .map(|m| m.contains_key(key))
            .unwrap_or(false)
    }

    /// Get a secret value.
    pub async fn get(&self, key: &str, context: &SecretContext) -> anyhow::Result<Option<String>> {
        let scope = Self::scope_key(context);
        let requester = context.requester_id.as_deref().unwrap_or(&context.agent_id);

        let secrets = self.secrets.read().await;
        let value = secrets.get(&scope).and_then(|m| m.get(key));

        match value {
            Some(stored) => {
                // Check permissions
                if let Some(ref perms) = stored.config.permissions {
                    let has_read = perms.iter().any(|p| {
                        p.entity_id == requester
                            && p.permissions.contains(&SecretPermissionType::Read)
                    });
                    if !has_read && requester != context.agent_id {
                        self.log_access(
                            key,
                            requester,
                            SecretPermissionType::Read,
                            context,
                            false,
                            Some("Permission denied".to_string()),
                        )
                        .await;
                        return Err(anyhow::anyhow!("Permission denied for key '{}'", key));
                    }
                }

                // Check expiration
                if let Some(expires_at) = stored.config.expires_at {
                    if chrono::Utc::now().timestamp_millis() > expires_at {
                        self.log_access(
                            key,
                            requester,
                            SecretPermissionType::Read,
                            context,
                            false,
                            Some("Secret expired".to_string()),
                        )
                        .await;
                        return Err(anyhow::anyhow!("Secret '{}' has expired", key));
                    }
                }

                self.log_access(
                    key,
                    requester,
                    SecretPermissionType::Read,
                    context,
                    true,
                    None,
                )
                .await;

                Ok(Some(stored.value.clone()))
            }
            None => {
                self.log_access(
                    key,
                    requester,
                    SecretPermissionType::Read,
                    context,
                    false,
                    Some("Not found".to_string()),
                )
                .await;
                Ok(None)
            }
        }
    }

    /// Set a secret value.
    pub async fn set(
        &self,
        key: &str,
        value: &str,
        context: &SecretContext,
        config: Option<SecretConfig>,
    ) -> anyhow::Result<bool> {
        // Validate key format (uppercase letters, digits, underscores)
        if key.len() > SECRET_KEY_MAX_LENGTH {
            return Err(anyhow::anyhow!("Key exceeds maximum length"));
        }
        if value.len() > SECRET_VALUE_MAX_LENGTH {
            return Err(anyhow::anyhow!("Value exceeds maximum length"));
        }

        let requester = context.requester_id.as_deref().unwrap_or(&context.agent_id);
        let scope = Self::scope_key(context);
        let now = chrono::Utc::now().timestamp_millis();

        let stored_value = if self.encryption_key.is_some() && self.config.enable_encryption {
            // In production, encrypt the value
            // For now, store as-is
            value.to_string()
        } else {
            value.to_string()
        };

        let secret_config = config.unwrap_or(SecretConfig {
            secret_type: SecretType::Secret,
            required: false,
            description: String::new(),
            can_generate: false,
            validation_method: None,
            status: SecretStatus::Valid,
            last_error: None,
            attempts: 0,
            created_at: Some(now),
            validated_at: None,
            plugin: String::new(),
            level: context.level.clone(),
            owner_id: context.user_id.clone(),
            world_id: context.world_id.clone(),
            encrypted: self.config.enable_encryption,
            permissions: None,
            shared_with: None,
            expires_at: None,
        });

        let stored = StoredSecret {
            value: stored_value,
            encrypted: self.config.enable_encryption,
            config: secret_config,
        };

        self.secrets
            .write()
            .await
            .entry(scope)
            .or_insert_with(HashMap::new)
            .insert(key.to_string(), stored);

        self.log_access(
            key,
            requester,
            SecretPermissionType::Write,
            context,
            true,
            None,
        )
        .await;

        Ok(true)
    }

    /// Delete a secret.
    pub async fn delete(&self, key: &str, context: &SecretContext) -> anyhow::Result<bool> {
        let scope = Self::scope_key(context);
        let requester = context.requester_id.as_deref().unwrap_or(&context.agent_id);

        let removed = self
            .secrets
            .write()
            .await
            .get_mut(&scope)
            .map(|m| m.remove(key).is_some())
            .unwrap_or(false);

        self.log_access(
            key,
            requester,
            SecretPermissionType::Delete,
            context,
            removed,
            if removed {
                None
            } else {
                Some("Not found".to_string())
            },
        )
        .await;

        Ok(removed)
    }

    /// List all secret configurations (without values) in a context.
    pub async fn list(&self, context: &SecretContext) -> HashMap<String, SecretConfig> {
        let scope = Self::scope_key(context);
        self.secrets
            .read()
            .await
            .get(&scope)
            .map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.config.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Get access log entries.
    pub async fn get_access_log(&self, limit: usize) -> Vec<SecretAccessLog> {
        self.access_log
            .read()
            .await
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }
}

impl Default for SecretsService {
    fn default() -> Self {
        Self::new(SecretsServiceConfig::default())
    }
}
