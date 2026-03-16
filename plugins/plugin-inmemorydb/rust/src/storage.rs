use async_trait::async_trait;
use parking_lot::RwLock;
use std::collections::HashMap;

use crate::types::{IStorage, PredicateFn, StorageResult};

pub struct MemoryStorage {
    collections: RwLock<HashMap<String, HashMap<String, serde_json::Value>>>,
    ready: RwLock<bool>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self {
            collections: RwLock::new(HashMap::new()),
            ready: RwLock::new(false),
        }
    }
}

impl Default for MemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl IStorage for MemoryStorage {
    async fn init(&self) -> StorageResult<()> {
        *self.ready.write() = true;
        Ok(())
    }

    async fn close(&self) -> StorageResult<()> {
        self.collections.write().clear();
        *self.ready.write() = false;
        Ok(())
    }

    async fn is_ready(&self) -> bool {
        *self.ready.read()
    }

    async fn get(&self, collection: &str, id: &str) -> StorageResult<Option<serde_json::Value>> {
        let collections = self.collections.read();
        Ok(collections
            .get(collection)
            .and_then(|col| col.get(id).cloned()))
    }

    async fn get_all(&self, collection: &str) -> StorageResult<Vec<serde_json::Value>> {
        let collections = self.collections.read();
        Ok(collections
            .get(collection)
            .map(|col| col.values().cloned().collect())
            .unwrap_or_default())
    }

    async fn get_where(
        &self,
        collection: &str,
        predicate: PredicateFn,
    ) -> StorageResult<Vec<serde_json::Value>> {
        let items: Vec<serde_json::Value> = {
            let collections = self.collections.read();
            collections
                .get(collection)
                .map(|col| col.values().cloned().collect())
                .unwrap_or_default()
        };
        Ok(items.into_iter().filter(|v| predicate(v)).collect())
    }

    async fn set(&self, collection: &str, id: &str, data: serde_json::Value) -> StorageResult<()> {
        let mut collections = self.collections.write();
        let col = collections.entry(collection.to_string()).or_default();
        col.insert(id.to_string(), data);
        Ok(())
    }

    async fn delete(&self, collection: &str, id: &str) -> StorageResult<bool> {
        let mut collections = self.collections.write();
        if let Some(col) = collections.get_mut(collection) {
            return Ok(col.remove(id).is_some());
        }
        Ok(false)
    }

    async fn delete_many(&self, collection: &str, ids: &[String]) -> StorageResult<()> {
        let mut collections = self.collections.write();
        if let Some(col) = collections.get_mut(collection) {
            for id in ids {
                col.remove(id);
            }
        }
        Ok(())
    }

    async fn delete_where(&self, collection: &str, predicate: PredicateFn) -> StorageResult<()> {
        let to_delete: Vec<String> = {
            let collections = self.collections.read();
            collections
                .get(collection)
                .map(|col| {
                    col.iter()
                        .filter(|(_, v)| predicate(v))
                        .map(|(k, _)| k.clone())
                        .collect()
                })
                .unwrap_or_default()
        };

        if !to_delete.is_empty() {
            let mut collections = self.collections.write();
            if let Some(col) = collections.get_mut(collection) {
                for key in to_delete {
                    col.remove(&key);
                }
            }
        }
        Ok(())
    }

    async fn count(
        &self,
        collection: &str,
        predicate: Option<PredicateFn>,
    ) -> StorageResult<usize> {
        let items: Vec<serde_json::Value> = {
            let collections = self.collections.read();
            collections
                .get(collection)
                .map(|col| col.values().cloned().collect())
                .unwrap_or_default()
        };

        let count = match predicate {
            Some(pred) => items.iter().filter(|v| pred(v)).count(),
            None => items.len(),
        };
        Ok(count)
    }

    async fn clear(&self) -> StorageResult<()> {
        self.collections.write().clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_basic_operations() {
        let storage = MemoryStorage::new();
        storage.init().await.unwrap();

        let data = serde_json::json!({"name": "test"});
        storage.set("test", "1", data.clone()).await.unwrap();

        let result = storage.get("test", "1").await.unwrap();
        assert_eq!(result, Some(data));

        assert!(storage.delete("test", "1").await.unwrap());
        assert_eq!(storage.get("test", "1").await.unwrap(), None);
    }

    #[tokio::test]
    async fn test_get_where() {
        let storage = MemoryStorage::new();
        storage.init().await.unwrap();

        storage
            .set("test", "1", serde_json::json!({"value": 1}))
            .await
            .unwrap();
        storage
            .set("test", "2", serde_json::json!({"value": 2}))
            .await
            .unwrap();
        storage
            .set("test", "3", serde_json::json!({"value": 3}))
            .await
            .unwrap();

        let results = storage
            .get_where(
                "test",
                Box::new(|v| v.get("value").and_then(|n| n.as_i64()).unwrap_or(0) > 1),
            )
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
    }
}
