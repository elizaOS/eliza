//! Storage interfaces and implementations for secrets.
//!
//! Provides abstract storage interface and in-memory implementation.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::types::{
    SecretConfig, SecretContext, SecretLevel, SecretMetadata, SecretsError, SecretsResult,
    StorageBackend,
};

/// Storage entry containing value and configuration.
#[derive(Debug, Clone)]
pub struct StorageEntry {
    /// The stored value (may be encrypted)
    pub value: serde_json::Value,
    /// Configuration for this secret
    pub config: SecretConfig,
}

/// Abstract interface for secret storage.
#[async_trait]
pub trait SecretStorage: Send + Sync {
    /// Get the storage backend type.
    fn storage_type(&self) -> StorageBackend;

    /// Initialize the storage.
    async fn initialize(&self) -> SecretsResult<()>;

    /// Check if a secret exists.
    async fn exists(&self, key: &str, context: &SecretContext) -> SecretsResult<bool>;

    /// Get a secret value.
    async fn get(&self, key: &str, context: &SecretContext) -> SecretsResult<Option<serde_json::Value>>;

    /// Set a secret value.
    async fn set(
        &self,
        key: &str,
        value: serde_json::Value,
        context: &SecretContext,
        config: Option<SecretConfig>,
    ) -> SecretsResult<bool>;

    /// Delete a secret.
    async fn delete(&self, key: &str, context: &SecretContext) -> SecretsResult<bool>;

    /// List secrets (metadata only).
    async fn list(&self, context: &SecretContext) -> SecretsResult<SecretMetadata>;

    /// Get secret configuration.
    async fn get_config(&self, key: &str, context: &SecretContext) -> SecretsResult<Option<SecretConfig>>;

    /// Update secret configuration.
    async fn update_config(
        &self,
        key: &str,
        context: &SecretContext,
        config: SecretConfig,
    ) -> SecretsResult<bool>;
}

/// Generate a storage key from context.
fn make_storage_key(key: &str, context: &SecretContext) -> String {
    match context.level {
        SecretLevel::Global => format!("global:{}", key),
        SecretLevel::World => {
            let world_id = context.world_id.as_deref().unwrap_or("default");
            format!("world:{}:{}", world_id, key)
        }
        SecretLevel::User => {
            let user_id = context.user_id.as_deref().unwrap_or("default");
            format!("user:{}:{}", user_id, key)
        }
    }
}

/// Create default secret configuration.
fn default_config() -> SecretConfig {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    SecretConfig {
        created_at: Some(now),
        updated_at: Some(now),
        ..Default::default()
    }
}

/// In-memory storage implementation.
pub struct MemorySecretStorage {
    data: Arc<RwLock<HashMap<String, StorageEntry>>>,
}

impl MemorySecretStorage {
    /// Create a new memory storage.
    pub fn new() -> Self {
        Self {
            data: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl Default for MemorySecretStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SecretStorage for MemorySecretStorage {
    fn storage_type(&self) -> StorageBackend {
        StorageBackend::Memory
    }

    async fn initialize(&self) -> SecretsResult<()> {
        Ok(())
    }

    async fn exists(&self, key: &str, context: &SecretContext) -> SecretsResult<bool> {
        let storage_key = make_storage_key(key, context);
        let data = self.data.read().await;
        Ok(data.contains_key(&storage_key))
    }

    async fn get(&self, key: &str, context: &SecretContext) -> SecretsResult<Option<serde_json::Value>> {
        let storage_key = make_storage_key(key, context);
        let data = self.data.read().await;
        Ok(data.get(&storage_key).map(|e| e.value.clone()))
    }

    async fn set(
        &self,
        key: &str,
        value: serde_json::Value,
        context: &SecretContext,
        config: Option<SecretConfig>,
    ) -> SecretsResult<bool> {
        let storage_key = make_storage_key(key, context);
        let mut data = self.data.write().await;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let existing_config = data.get(&storage_key).map(|e| e.config.clone());
        let mut final_config = config.unwrap_or_else(|| existing_config.unwrap_or_else(default_config));
        final_config.updated_at = Some(now);
        if final_config.created_at.is_none() {
            final_config.created_at = Some(now);
        }

        data.insert(
            storage_key,
            StorageEntry {
                value,
                config: final_config,
            },
        );

        Ok(true)
    }

    async fn delete(&self, key: &str, context: &SecretContext) -> SecretsResult<bool> {
        let storage_key = make_storage_key(key, context);
        let mut data = self.data.write().await;
        Ok(data.remove(&storage_key).is_some())
    }

    async fn list(&self, context: &SecretContext) -> SecretsResult<SecretMetadata> {
        let prefix = match context.level {
            SecretLevel::Global => "global:".to_string(),
            SecretLevel::World => {
                let world_id = context.world_id.as_deref().unwrap_or("default");
                format!("world:{}:", world_id)
            }
            SecretLevel::User => {
                let user_id = context.user_id.as_deref().unwrap_or("default");
                format!("user:{}:", user_id)
            }
        };

        let data = self.data.read().await;
        let mut keys = Vec::new();
        let mut configs = HashMap::new();
        let mut last_modified: Option<i64> = None;

        for (storage_key, entry) in data.iter() {
            if storage_key.starts_with(&prefix) {
                let key = storage_key.strip_prefix(&prefix).unwrap_or(storage_key);
                keys.push(key.to_string());
                configs.insert(key.to_string(), entry.config.clone());

                if let Some(updated) = entry.config.updated_at {
                    last_modified = Some(last_modified.map_or(updated, |lm| lm.max(updated)));
                }
            }
        }

        let count = keys.len();

        Ok(SecretMetadata {
            keys,
            configs,
            count,
            last_modified,
        })
    }

    async fn get_config(&self, key: &str, context: &SecretContext) -> SecretsResult<Option<SecretConfig>> {
        let storage_key = make_storage_key(key, context);
        let data = self.data.read().await;
        Ok(data.get(&storage_key).map(|e| e.config.clone()))
    }

    async fn update_config(
        &self,
        key: &str,
        context: &SecretContext,
        config: SecretConfig,
    ) -> SecretsResult<bool> {
        let storage_key = make_storage_key(key, context);
        let mut data = self.data.write().await;

        if let Some(entry) = data.get_mut(&storage_key) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            let mut updated_config = config;
            updated_config.updated_at = Some(now);
            updated_config.created_at = entry.config.created_at;
            entry.config = updated_config;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

/// Composite storage that delegates to different backends based on level.
pub struct CompositeSecretStorage {
    global_storage: Arc<dyn SecretStorage>,
    world_storage: Arc<dyn SecretStorage>,
    user_storage: Arc<dyn SecretStorage>,
}

impl CompositeSecretStorage {
    /// Create a new composite storage.
    pub fn new(
        global_storage: Arc<dyn SecretStorage>,
        world_storage: Arc<dyn SecretStorage>,
        user_storage: Arc<dyn SecretStorage>,
    ) -> Self {
        Self {
            global_storage,
            world_storage,
            user_storage,
        }
    }

    /// Create with default memory storage for all levels.
    pub fn with_memory_storage() -> Self {
        Self {
            global_storage: Arc::new(MemorySecretStorage::new()),
            world_storage: Arc::new(MemorySecretStorage::new()),
            user_storage: Arc::new(MemorySecretStorage::new()),
        }
    }

    /// Get the storage for a given context.
    fn storage_for(&self, context: &SecretContext) -> &Arc<dyn SecretStorage> {
        match context.level {
            SecretLevel::Global => &self.global_storage,
            SecretLevel::World => &self.world_storage,
            SecretLevel::User => &self.user_storage,
        }
    }
}

#[async_trait]
impl SecretStorage for CompositeSecretStorage {
    fn storage_type(&self) -> StorageBackend {
        StorageBackend::Memory // Composite doesn't have a specific type
    }

    async fn initialize(&self) -> SecretsResult<()> {
        self.global_storage.initialize().await?;
        self.world_storage.initialize().await?;
        self.user_storage.initialize().await?;
        Ok(())
    }

    async fn exists(&self, key: &str, context: &SecretContext) -> SecretsResult<bool> {
        self.storage_for(context).exists(key, context).await
    }

    async fn get(&self, key: &str, context: &SecretContext) -> SecretsResult<Option<serde_json::Value>> {
        self.storage_for(context).get(key, context).await
    }

    async fn set(
        &self,
        key: &str,
        value: serde_json::Value,
        context: &SecretContext,
        config: Option<SecretConfig>,
    ) -> SecretsResult<bool> {
        self.storage_for(context).set(key, value, context, config).await
    }

    async fn delete(&self, key: &str, context: &SecretContext) -> SecretsResult<bool> {
        self.storage_for(context).delete(key, context).await
    }

    async fn list(&self, context: &SecretContext) -> SecretsResult<SecretMetadata> {
        self.storage_for(context).list(context).await
    }

    async fn get_config(&self, key: &str, context: &SecretContext) -> SecretsResult<Option<SecretConfig>> {
        self.storage_for(context).get_config(key, context).await
    }

    async fn update_config(
        &self,
        key: &str,
        context: &SecretContext,
        config: SecretConfig,
    ) -> SecretsResult<bool> {
        self.storage_for(context).update_config(key, context, config).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_memory_storage_basic() {
        let storage = MemorySecretStorage::new();
        storage.initialize().await.unwrap();

        let context = SecretContext::global("agent-123");

        // Initially not exists
        assert!(!storage.exists("TEST_KEY", &context).await.unwrap());

        // Set a value
        let value = serde_json::json!("secret-value");
        storage.set("TEST_KEY", value.clone(), &context, None).await.unwrap();

        // Now exists
        assert!(storage.exists("TEST_KEY", &context).await.unwrap());

        // Get the value
        let retrieved = storage.get("TEST_KEY", &context).await.unwrap();
        assert_eq!(retrieved, Some(value));

        // Delete
        assert!(storage.delete("TEST_KEY", &context).await.unwrap());
        assert!(!storage.exists("TEST_KEY", &context).await.unwrap());
    }

    #[tokio::test]
    async fn test_memory_storage_list() {
        let storage = MemorySecretStorage::new();
        storage.initialize().await.unwrap();

        let context = SecretContext::global("agent-123");

        storage.set("KEY1", serde_json::json!("value1"), &context, None).await.unwrap();
        storage.set("KEY2", serde_json::json!("value2"), &context, None).await.unwrap();

        let metadata = storage.list(&context).await.unwrap();
        assert_eq!(metadata.count, 2);
        assert!(metadata.keys.contains(&"KEY1".to_string()));
        assert!(metadata.keys.contains(&"KEY2".to_string()));
    }

    #[tokio::test]
    async fn test_memory_storage_config() {
        let storage = MemorySecretStorage::new();
        storage.initialize().await.unwrap();

        let context = SecretContext::global("agent-123");

        let mut config = default_config();
        config.description = Some("Test secret".to_string());

        storage.set("TEST_KEY", serde_json::json!("value"), &context, Some(config.clone())).await.unwrap();

        let retrieved_config = storage.get_config("TEST_KEY", &context).await.unwrap();
        assert!(retrieved_config.is_some());
        assert_eq!(retrieved_config.unwrap().description, Some("Test secret".to_string()));
    }

    #[tokio::test]
    async fn test_composite_storage() {
        let storage = CompositeSecretStorage::with_memory_storage();
        storage.initialize().await.unwrap();

        let global_ctx = SecretContext::global("agent-123");
        let world_ctx = SecretContext::world("agent-123", "world-456");
        let user_ctx = SecretContext::user("agent-123", "user-789", None);

        // Set different values in different levels
        storage.set("KEY", serde_json::json!("global"), &global_ctx, None).await.unwrap();
        storage.set("KEY", serde_json::json!("world"), &world_ctx, None).await.unwrap();
        storage.set("KEY", serde_json::json!("user"), &user_ctx, None).await.unwrap();

        // Retrieve from each level
        assert_eq!(storage.get("KEY", &global_ctx).await.unwrap(), Some(serde_json::json!("global")));
        assert_eq!(storage.get("KEY", &world_ctx).await.unwrap(), Some(serde_json::json!("world")));
        assert_eq!(storage.get("KEY", &user_ctx).await.unwrap(), Some(serde_json::json!("user")));
    }

    #[tokio::test]
    async fn test_storage_key_generation() {
        let global_key = make_storage_key("TEST", &SecretContext::global("agent"));
        assert_eq!(global_key, "global:TEST");

        let world_key = make_storage_key("TEST", &SecretContext::world("agent", "world"));
        assert_eq!(world_key, "world:world:TEST");

        let user_key = make_storage_key("TEST", &SecretContext::user("agent", "user", None));
        assert_eq!(user_key, "user:user:TEST");
    }
}
