#![allow(missing_docs)]

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::hnsw::{HNSWIndex, SimpleHNSW};
use crate::storage::JsonStorage;

pub mod collections {
    pub const AGENTS: &str = "agents";
    pub const ENTITIES: &str = "entities";
    pub const MEMORIES: &str = "memories";
    pub const ROOMS: &str = "rooms";
    pub const WORLDS: &str = "worlds";
    pub const COMPONENTS: &str = "components";
    pub const RELATIONSHIPS: &str = "relationships";
    pub const PARTICIPANTS: &str = "participants";
    pub const TASKS: &str = "tasks";
    pub const CACHE: &str = "cache";
    pub const LOGS: &str = "logs";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMemory {
    pub id: String,
    pub entity_id: String,
    pub agent_id: Option<String>,
    pub room_id: String,
    pub world_id: Option<String>,
    pub content: serde_json::Value,
    pub embedding: Option<Vec<f32>>,
    pub unique: bool,
    pub created_at: i64,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredParticipant {
    pub id: String,
    pub entity_id: String,
    pub room_id: String,
    pub user_state: Option<String>,
}

pub struct LocalDatabaseAdapter {
    storage: Arc<JsonStorage>,
    vector_index: SimpleHNSW,
    embedding_dimension: usize,
    agent_id: String,
    ready: bool,
}

impl LocalDatabaseAdapter {
    pub fn new(storage: JsonStorage, agent_id: String) -> Self {
        Self {
            storage: Arc::new(storage),
            vector_index: SimpleHNSW::new(),
            embedding_dimension: 384,
            agent_id,
            ready: false,
        }
    }

    pub async fn init(&mut self) -> Result<()> {
        self.storage.init().await?;
        self.vector_index.init(self.embedding_dimension);

        if let Ok(Some(data)) = self.storage.load_raw("vectors/hnsw_index.json") {
            if let Ok(index) = serde_json::from_str::<HNSWIndex>(&data) {
                if index.dimension == self.embedding_dimension {
                    self.vector_index.load_from_index(index);
                }
            }
        }

        self.ready = true;
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.ready && self.storage.is_ready()
    }

    pub async fn close(&mut self) -> Result<()> {
        let index = self.vector_index.serialize();
        let data = serde_json::to_string(&index)?;
        self.storage.save_raw("vectors/hnsw_index.json", &data)?;

        self.storage.close().await?;
        self.ready = false;
        Ok(())
    }

    pub fn ensure_embedding_dimension(&mut self, dimension: usize) {
        if self.embedding_dimension != dimension {
            self.embedding_dimension = dimension;
            self.vector_index.init(dimension);
        }
    }

    pub fn create_memory(&mut self, memory: StoredMemory) -> Result<String> {
        let id = if memory.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            memory.id.clone()
        };

        let mut stored = memory;
        stored.id = id.clone();
        if stored.agent_id.is_none() {
            stored.agent_id = Some(self.agent_id.clone());
        }

        self.storage.set(collections::MEMORIES, &id, &stored)?;

        if let Some(ref embedding) = stored.embedding {
            if !embedding.is_empty() {
                self.vector_index.add(id.clone(), embedding.clone())?;
            }
        }

        Ok(id)
    }

    pub fn get_memory(&self, id: &str) -> Result<Option<StoredMemory>> {
        self.storage.get(collections::MEMORIES, id)
    }

    pub fn search_memories(
        &self,
        embedding: &[f32],
        count: usize,
        threshold: f32,
    ) -> Result<Vec<(StoredMemory, f32)>> {
        let results = self.vector_index.search(embedding, count * 2, threshold);

        let mut memories = Vec::new();
        for result in results.into_iter().take(count) {
            if let Some(memory) = self.get_memory(&result.id)? {
                memories.push((memory, result.similarity));
            }
        }

        Ok(memories)
    }

    pub fn delete_memory(&mut self, id: &str) -> Result<bool> {
        self.vector_index.remove(id);
        self.storage.delete(collections::MEMORIES, id)
    }

    pub fn get_agent<T: serde::de::DeserializeOwned>(&self, id: &str) -> Result<Option<T>> {
        self.storage.get(collections::AGENTS, id)
    }

    pub fn create_agent<T: Serialize>(&self, id: &str, agent: &T) -> Result<()> {
        self.storage.set(collections::AGENTS, id, agent)
    }

    pub fn delete_agent(&self, id: &str) -> Result<bool> {
        self.storage.delete(collections::AGENTS, id)
    }

    pub fn get_room<T: serde::de::DeserializeOwned>(&self, id: &str) -> Result<Option<T>> {
        self.storage.get(collections::ROOMS, id)
    }

    pub fn create_room<T: Serialize>(&self, id: &str, room: &T) -> Result<()> {
        self.storage.set(collections::ROOMS, id, room)
    }

    pub fn delete_room(&self, id: &str) -> Result<bool> {
        self.storage.delete(collections::ROOMS, id)
    }

    pub fn get_cache<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        self.storage.get(collections::CACHE, key)
    }

    pub fn set_cache<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.storage.set(collections::CACHE, key, value)
    }

    pub fn delete_cache(&self, key: &str) -> Result<bool> {
        self.storage.delete(collections::CACHE, key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_adapter_basic() {
        let dir = tempdir().unwrap();
        let storage = JsonStorage::new(dir.path()).unwrap();
        let mut adapter = LocalDatabaseAdapter::new(storage, "test-agent".to_string());

        adapter.init().await.unwrap();
        assert!(adapter.is_ready());

        adapter.ensure_embedding_dimension(3);

        let memory = StoredMemory {
            id: String::new(),
            entity_id: "entity-1".to_string(),
            agent_id: None,
            room_id: "room-1".to_string(),
            world_id: None,
            content: serde_json::json!({"text": "Hello world"}),
            embedding: Some(vec![1.0, 0.0, 0.0]),
            unique: false,
            created_at: 0,
            metadata: None,
        };

        let id = adapter.create_memory(memory).unwrap();
        assert!(!id.is_empty());

        let retrieved = adapter.get_memory(&id).unwrap();
        assert!(retrieved.is_some());

        let results = adapter.search_memories(&[1.0, 0.0, 0.0], 10, 0.5).unwrap();
        assert!(!results.is_empty());

        adapter.close().await.unwrap();
    }
}
