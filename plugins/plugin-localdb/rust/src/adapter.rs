#![allow(missing_docs)]
//! Local JSON-based database adapter for elizaOS.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::hnsw::{HNSWIndex, SimpleHNSW};
use crate::storage::JsonStorage;

/// Collection names used by the adapter.
pub mod collections {
    /// Collection name for storing agent data.
    pub const AGENTS: &str = "agents";
    /// Collection name for storing entity data.
    pub const ENTITIES: &str = "entities";
    /// Collection name for storing memory data.
    pub const MEMORIES: &str = "memories";
    /// Collection name for storing room data.
    pub const ROOMS: &str = "rooms";
    /// Collection name for storing world data.
    pub const WORLDS: &str = "worlds";
    /// Collection name for storing component data.
    pub const COMPONENTS: &str = "components";
    /// Collection name for storing relationship data.
    pub const RELATIONSHIPS: &str = "relationships";
    /// Collection name for storing participant data.
    pub const PARTICIPANTS: &str = "participants";
    /// Collection name for storing task data.
    pub const TASKS: &str = "tasks";
    /// Collection name for storing cache data.
    pub const CACHE: &str = "cache";
    /// Collection name for storing log data.
    pub const LOGS: &str = "logs";
}

/// Stored memory format for JSON persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMemory {
    /// Unique identifier for the memory.
    pub id: String,
    /// ID of the entity that created this memory.
    pub entity_id: String,
    /// ID of the agent associated with this memory.
    pub agent_id: Option<String>,
    /// ID of the room where this memory was created.
    pub room_id: String,
    /// ID of the world this memory belongs to.
    pub world_id: Option<String>,
    /// The actual content of the memory.
    pub content: serde_json::Value,
    /// Vector embedding for similarity search.
    pub embedding: Option<Vec<f32>>,
    /// Whether this memory is unique.
    pub unique: bool,
    /// Timestamp when the memory was created.
    pub created_at: i64,
    /// Additional metadata for the memory.
    pub metadata: Option<serde_json::Value>,
}

/// Stored participant format for JSON persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredParticipant {
    /// Unique identifier for the participant record.
    pub id: String,
    /// ID of the entity participating.
    pub entity_id: String,
    /// ID of the room the entity is participating in.
    pub room_id: String,
    /// Current state of the user (e.g., "FOLLOWED", "MUTED").
    pub user_state: Option<String>,
}

/// Local JSON-based database adapter.
pub struct LocalDatabaseAdapter {
    storage: Arc<JsonStorage>,
    vector_index: SimpleHNSW,
    embedding_dimension: usize,
    agent_id: String,
    ready: bool,
}

impl LocalDatabaseAdapter {
    /// Create a new adapter.
    pub fn new(storage: JsonStorage, agent_id: String) -> Self {
        Self {
            storage: Arc::new(storage),
            vector_index: SimpleHNSW::new(),
            embedding_dimension: 384,
            agent_id,
            ready: false,
        }
    }

    /// Initialize the adapter.
    pub async fn init(&mut self) -> Result<()> {
        self.storage.init().await?;
        self.vector_index.init(self.embedding_dimension);
        
        // Try to load existing HNSW index
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

    /// Check if the adapter is ready.
    pub fn is_ready(&self) -> bool {
        self.ready && self.storage.is_ready()
    }

    /// Close the adapter.
    pub async fn close(&mut self) -> Result<()> {
        // Save HNSW index
        let index = self.vector_index.serialize();
        let data = serde_json::to_string(&index)?;
        self.storage.save_raw("vectors/hnsw_index.json", &data)?;
        
        self.storage.close().await?;
        self.ready = false;
        Ok(())
    }

    /// Ensure embedding dimension is set.
    pub fn ensure_embedding_dimension(&mut self, dimension: usize) {
        if self.embedding_dimension != dimension {
            self.embedding_dimension = dimension;
            self.vector_index.init(dimension);
        }
    }

    // ==================== Memory Methods ====================

    /// Create a memory.
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

        // Index embedding if present
        if let Some(ref embedding) = stored.embedding {
            if !embedding.is_empty() {
                self.vector_index.add(id.clone(), embedding.clone())?;
            }
        }

        Ok(id)
    }

    /// Get a memory by ID.
    pub fn get_memory(&self, id: &str) -> Result<Option<StoredMemory>> {
        self.storage.get(collections::MEMORIES, id)
    }

    /// Search memories by vector similarity.
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

    /// Delete a memory.
    pub fn delete_memory(&mut self, id: &str) -> Result<bool> {
        self.vector_index.remove(id);
        self.storage.delete(collections::MEMORIES, id)
    }

    // ==================== Agent Methods ====================

    /// Get an agent by ID.
    pub fn get_agent<T: serde::de::DeserializeOwned>(&self, id: &str) -> Result<Option<T>> {
        self.storage.get(collections::AGENTS, id)
    }

    /// Create an agent.
    pub fn create_agent<T: Serialize>(&self, id: &str, agent: &T) -> Result<()> {
        self.storage.set(collections::AGENTS, id, agent)
    }

    /// Delete an agent.
    pub fn delete_agent(&self, id: &str) -> Result<bool> {
        self.storage.delete(collections::AGENTS, id)
    }

    // ==================== Room Methods ====================

    /// Get a room by ID.
    pub fn get_room<T: serde::de::DeserializeOwned>(&self, id: &str) -> Result<Option<T>> {
        self.storage.get(collections::ROOMS, id)
    }

    /// Create a room.
    pub fn create_room<T: Serialize>(&self, id: &str, room: &T) -> Result<()> {
        self.storage.set(collections::ROOMS, id, room)
    }

    /// Delete a room.
    pub fn delete_room(&self, id: &str) -> Result<bool> {
        self.storage.delete(collections::ROOMS, id)
    }

    // ==================== Cache Methods ====================

    /// Get a cached value.
    pub fn get_cache<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        self.storage.get(collections::CACHE, key)
    }

    /// Set a cached value.
    pub fn set_cache<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.storage.set(collections::CACHE, key, value)
    }

    /// Delete a cached value.
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

        // Set embedding dimension to 3 for this test
        adapter.ensure_embedding_dimension(3);

        // Create a memory
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

        // Get memory
        let retrieved = adapter.get_memory(&id).unwrap();
        assert!(retrieved.is_some());

        // Search
        let results = adapter.search_memories(&[1.0, 0.0, 0.0], 10, 0.5).unwrap();
        assert!(!results.is_empty());

        adapter.close().await.unwrap();
    }
}

