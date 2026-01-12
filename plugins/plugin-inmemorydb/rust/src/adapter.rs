#![allow(missing_docs)]

use chrono::Utc;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

use crate::hnsw::EphemeralHNSW;
use crate::storage::MemoryStorage;
use crate::types::{IStorage, IVectorStorage, StorageResult, COLLECTIONS};

pub struct InMemoryDatabaseAdapter {
    storage: Arc<MemoryStorage>,
    vector_index: EphemeralHNSW,
    embedding_dimension: usize,
    ready: bool,
    agent_id: String,
}

impl InMemoryDatabaseAdapter {
    pub fn new(storage: Arc<MemoryStorage>, agent_id: String) -> Self {
        Self {
            storage,
            vector_index: EphemeralHNSW::new(),
            embedding_dimension: 384,
            ready: false,
            agent_id,
        }
    }

    pub async fn init(&mut self) -> StorageResult<()> {
        self.storage.init().await?;
        self.vector_index.init(self.embedding_dimension).await?;
        self.ready = true;
        Ok(())
    }

    pub async fn is_ready(&self) -> bool {
        self.ready && self.storage.is_ready().await
    }

    pub async fn close(&mut self) -> StorageResult<()> {
        self.vector_index.clear().await?;
        self.storage.close().await?;
        self.ready = false;
        Ok(())
    }

    pub async fn ensure_embedding_dimension(&mut self, dimension: usize) -> StorageResult<()> {
        if self.embedding_dimension != dimension {
            self.embedding_dimension = dimension;
            self.vector_index.init(dimension).await?;
        }
        Ok(())
    }

    pub async fn get_agent(&self, agent_id: &str) -> StorageResult<Option<serde_json::Value>> {
        self.storage.get(COLLECTIONS::AGENTS, agent_id).await
    }

    pub async fn get_agents(&self) -> StorageResult<Vec<serde_json::Value>> {
        self.storage.get_all(COLLECTIONS::AGENTS).await
    }

    pub async fn create_agent(&self, agent: serde_json::Value) -> StorageResult<bool> {
        let id = agent
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        match id {
            Some(id) => {
                self.storage.set(COLLECTIONS::AGENTS, &id, agent).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub async fn update_agent(
        &self,
        agent_id: &str,
        agent: serde_json::Value,
    ) -> StorageResult<bool> {
        let existing = self.get_agent(agent_id).await?;
        match existing {
            Some(existing) => {
                let mut updated = existing;
                if let (Some(existing_obj), Some(agent_obj)) =
                    (updated.as_object_mut(), agent.as_object())
                {
                    for (k, v) in agent_obj {
                        existing_obj.insert(k.clone(), v.clone());
                    }
                }
                self.storage
                    .set(COLLECTIONS::AGENTS, agent_id, updated)
                    .await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub async fn delete_agent(&self, agent_id: &str) -> StorageResult<bool> {
        self.storage.delete(COLLECTIONS::AGENTS, agent_id).await
    }

    pub async fn get_memories(
        &self,
        entity_id: Option<&str>,
        agent_id: Option<&str>,
        room_id: Option<&str>,
        world_id: Option<&str>,
        table_name: &str,
        count: Option<usize>,
        offset: Option<usize>,
        _unique: Option<bool>,
    ) -> StorageResult<Vec<serde_json::Value>> {
        let entity_id_owned = entity_id.map(|s| s.to_string());
        let agent_id_owned = agent_id.map(|s| s.to_string());
        let room_id_owned = room_id.map(|s| s.to_string());
        let world_id_owned = world_id.map(|s| s.to_string());
        let table_name_owned = table_name.to_string();

        let mut memories = self
            .storage
            .get_where(
                COLLECTIONS::MEMORIES,
                Box::new(move |m| {
                    if let Some(ref eid) = entity_id_owned {
                        if m.get("entityId").and_then(|v| v.as_str()) != Some(eid) {
                            return false;
                        }
                    }
                    if let Some(ref aid) = agent_id_owned {
                        if m.get("agentId").and_then(|v| v.as_str()) != Some(aid) {
                            return false;
                        }
                    }
                    if let Some(ref rid) = room_id_owned {
                        if m.get("roomId").and_then(|v| v.as_str()) != Some(rid) {
                            return false;
                        }
                    }
                    if let Some(ref wid) = world_id_owned {
                        if m.get("worldId").and_then(|v| v.as_str()) != Some(wid) {
                            return false;
                        }
                    }
                    if let Some(metadata) = m.get("metadata") {
                        if metadata.get("type").and_then(|v| v.as_str()) != Some(&table_name_owned)
                        {
                            return false;
                        }
                    }
                    true
                }),
            )
            .await?;

        memories.sort_by(|a, b| {
            let a_time = a.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            let b_time = b.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            b_time.cmp(&a_time)
        });

        if let Some(off) = offset {
            memories = memories.into_iter().skip(off).collect();
        }
        if let Some(cnt) = count {
            memories = memories.into_iter().take(cnt).collect();
        }

        Ok(memories)
    }

    pub async fn get_memory_by_id(&self, id: &str) -> StorageResult<Option<serde_json::Value>> {
        self.storage.get(COLLECTIONS::MEMORIES, id).await
    }

    pub async fn search_memories(
        &self,
        table_name: &str,
        embedding: &[f32],
        match_threshold: Option<f32>,
        count: Option<usize>,
        room_id: Option<&str>,
        world_id: Option<&str>,
        entity_id: Option<&str>,
        unique: Option<bool>,
    ) -> StorageResult<Vec<serde_json::Value>> {
        let threshold = match_threshold.unwrap_or(0.5);
        let k = count.unwrap_or(10);

        let results = self
            .vector_index
            .search(embedding, k * 2, threshold)
            .await?;

        let mut memories = Vec::new();
        for result in results {
            let memory = self.get_memory_by_id(&result.id).await?;
            if let Some(mut memory) = memory {
                if let Some(metadata) = memory.get("metadata") {
                    if metadata.get("type").and_then(|v| v.as_str()) != Some(table_name) {
                        continue;
                    }
                }
                if let Some(rid) = room_id {
                    if memory.get("roomId").and_then(|v| v.as_str()) != Some(rid) {
                        continue;
                    }
                }
                if let Some(wid) = world_id {
                    if memory.get("worldId").and_then(|v| v.as_str()) != Some(wid) {
                        continue;
                    }
                }
                if let Some(eid) = entity_id {
                    if memory.get("entityId").and_then(|v| v.as_str()) != Some(eid) {
                        continue;
                    }
                }
                if unique == Some(true) && memory.get("unique") != Some(&json!(true)) {
                    continue;
                }

                memory
                    .as_object_mut()
                    .unwrap()
                    .insert("similarity".to_string(), json!(result.similarity));
                memories.push(memory);
            }
        }

        Ok(memories.into_iter().take(k).collect())
    }

    pub async fn create_memory(
        &self,
        memory: serde_json::Value,
        table_name: &str,
        unique: bool,
    ) -> StorageResult<String> {
        let id = memory
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let now = Utc::now().timestamp_millis();

        let mut stored_memory = memory.clone();
        let obj = stored_memory.as_object_mut().unwrap();
        obj.insert("id".to_string(), json!(id));
        obj.insert(
            "agentId".to_string(),
            memory
                .get("agentId")
                .cloned()
                .unwrap_or_else(|| json!(self.agent_id)),
        );
        obj.insert(
            "unique".to_string(),
            json!(unique || memory.get("unique") == Some(&json!(true))),
        );
        obj.insert(
            "createdAt".to_string(),
            memory
                .get("createdAt")
                .cloned()
                .unwrap_or_else(|| json!(now)),
        );

        let mut metadata = memory.get("metadata").cloned().unwrap_or_else(|| json!({}));
        metadata
            .as_object_mut()
            .unwrap()
            .insert("type".to_string(), json!(table_name));
        obj.insert("metadata".to_string(), metadata);

        self.storage
            .set(COLLECTIONS::MEMORIES, &id, stored_memory)
            .await?;

        if let Some(embedding) = memory.get("embedding").and_then(|v| v.as_array()) {
            let embedding: Vec<f32> = embedding
                .iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect();
            if !embedding.is_empty() {
                self.vector_index.add(&id, &embedding).await?;
            }
        }

        Ok(id)
    }

    pub async fn delete_memory(&self, memory_id: &str) -> StorageResult<()> {
        self.storage
            .delete(COLLECTIONS::MEMORIES, memory_id)
            .await?;
        self.vector_index.remove(memory_id).await?;
        Ok(())
    }

    pub async fn create_world(&self, world: serde_json::Value) -> StorageResult<String> {
        let id = world
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let mut stored = world;
        stored
            .as_object_mut()
            .unwrap()
            .insert("id".to_string(), json!(id));

        self.storage.set(COLLECTIONS::WORLDS, &id, stored).await?;
        Ok(id)
    }

    pub async fn get_world(&self, id: &str) -> StorageResult<Option<serde_json::Value>> {
        self.storage.get(COLLECTIONS::WORLDS, id).await
    }

    pub async fn get_all_worlds(&self) -> StorageResult<Vec<serde_json::Value>> {
        self.storage.get_all(COLLECTIONS::WORLDS).await
    }

    pub async fn create_rooms(&self, rooms: Vec<serde_json::Value>) -> StorageResult<Vec<String>> {
        let mut ids = Vec::new();
        for room in rooms {
            let id = room
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| Uuid::new_v4().to_string());

            let mut stored = room;
            stored
                .as_object_mut()
                .unwrap()
                .insert("id".to_string(), json!(id.clone()));

            self.storage.set(COLLECTIONS::ROOMS, &id, stored).await?;
            ids.push(id);
        }
        Ok(ids)
    }

    pub async fn get_rooms_by_ids(
        &self,
        room_ids: &[String],
    ) -> StorageResult<Option<Vec<serde_json::Value>>> {
        let mut rooms = Vec::new();
        for id in room_ids {
            if let Some(room) = self.storage.get(COLLECTIONS::ROOMS, id).await? {
                rooms.push(room);
            }
        }
        if rooms.is_empty() {
            Ok(None)
        } else {
            Ok(Some(rooms))
        }
    }

    pub async fn delete_room(&self, room_id: &str) -> StorageResult<()> {
        self.storage.delete(COLLECTIONS::ROOMS, room_id).await?;

        let room_id_owned = room_id.to_string();
        self.storage
            .delete_where(
                COLLECTIONS::PARTICIPANTS,
                Box::new(move |p| p.get("roomId").and_then(|v| v.as_str()) == Some(&room_id_owned)),
            )
            .await?;

        let room_id_owned = room_id.to_string();
        self.storage
            .delete_where(
                COLLECTIONS::MEMORIES,
                Box::new(move |m| m.get("roomId").and_then(|v| v.as_str()) == Some(&room_id_owned)),
            )
            .await?;

        Ok(())
    }

    pub async fn get_cache(&self, key: &str) -> StorageResult<Option<serde_json::Value>> {
        let cached = self.storage.get(COLLECTIONS::CACHE, key).await?;
        if let Some(cached) = cached {
            if let Some(expires_at) = cached.get("expiresAt").and_then(|v| v.as_i64()) {
                let now = Utc::now().timestamp_millis();
                if now > expires_at {
                    self.storage.delete(COLLECTIONS::CACHE, key).await?;
                    return Ok(None);
                }
            }
            return Ok(cached.get("value").cloned());
        }
        Ok(None)
    }

    pub async fn set_cache(&self, key: &str, value: serde_json::Value) -> StorageResult<bool> {
        self.storage
            .set(COLLECTIONS::CACHE, key, json!({ "value": value }))
            .await?;
        Ok(true)
    }

    pub async fn delete_cache(&self, key: &str) -> StorageResult<bool> {
        self.storage.delete(COLLECTIONS::CACHE, key).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_adapter_init() {
        let storage = Arc::new(MemoryStorage::new());
        let mut adapter = InMemoryDatabaseAdapter::new(storage, "test".to_string());
        adapter.init().await.unwrap();
        assert!(adapter.is_ready().await);
    }

    #[tokio::test]
    async fn test_agent_crud() {
        let storage = Arc::new(MemoryStorage::new());
        let mut adapter = InMemoryDatabaseAdapter::new(storage, "test".to_string());
        adapter.init().await.unwrap();

        let agent = json!({"id": "agent1", "name": "Test Agent"});
        assert!(adapter.create_agent(agent).await.unwrap());

        let fetched = adapter.get_agent("agent1").await.unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().get("name").unwrap(), "Test Agent");

        assert!(adapter.delete_agent("agent1").await.unwrap());
        assert!(adapter.get_agent("agent1").await.unwrap().is_none());
    }
}
