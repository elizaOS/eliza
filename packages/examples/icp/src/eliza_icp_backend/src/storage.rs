//! ICP Stable Memory Storage for elizaOS
//!
//! This module provides the same interface as plugin-inmemorydb but uses
//! ICP's stable memory for persistence across canister upgrades.
//!
//! Key differences from plugin-inmemorydb:
//! - Uses StableBTreeMap instead of HashMap
//! - Data persists across canister upgrades
//! - No async (ICP is single-threaded)
//! - Predicates are evaluated by iterating (no closures in stable storage)

use crate::types::{generate_uuid, now_millis, StorageError, StorageResult, VectorSearchResult, COLLECTIONS};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;

type StableMemory = VirtualMemory<DefaultMemoryImpl>;

// Memory IDs for different collections
const MEMORY_ID_DATA: MemoryId = MemoryId::new(0);
const MEMORY_ID_VECTORS: MemoryId = MemoryId::new(1);

// ========== Storable Wrappers ==========

#[derive(Clone, Debug)]
struct StorableString(String);

impl ic_stable_structures::Storable for StorableString {
    fn to_bytes(&self) -> std::borrow::Cow<[u8]> {
        std::borrow::Cow::Owned(self.0.as_bytes().to_vec())
    }

    fn from_bytes(bytes: std::borrow::Cow<[u8]>) -> Self {
        Self(String::from_utf8_lossy(&bytes).to_string())
    }

    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Bounded {
            max_size: 512, // collection:id format
            is_fixed_size: false,
        };
}

impl Ord for StorableString {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.cmp(&other.0)
    }
}

impl PartialOrd for StorableString {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for StorableString {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Eq for StorableString {}

#[derive(Clone, Debug)]
struct StorableValue(Value);

impl ic_stable_structures::Storable for StorableValue {
    fn to_bytes(&self) -> std::borrow::Cow<[u8]> {
        std::borrow::Cow::Owned(serde_json::to_vec(&self.0).unwrap_or_default())
    }

    fn from_bytes(bytes: std::borrow::Cow<[u8]>) -> Self {
        Self(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Bounded {
            max_size: 65536, // 64KB max per value
            is_fixed_size: false,
        };
}

#[derive(Clone, Debug)]
struct StorableVector(Vec<f32>);

impl ic_stable_structures::Storable for StorableVector {
    fn to_bytes(&self) -> std::borrow::Cow<[u8]> {
        let bytes: Vec<u8> = self.0.iter().flat_map(|f| f.to_le_bytes()).collect();
        std::borrow::Cow::Owned(bytes)
    }

    fn from_bytes(bytes: std::borrow::Cow<[u8]>) -> Self {
        let floats: Vec<f32> = bytes
            .chunks(4)
            .filter_map(|chunk| {
                if chunk.len() == 4 {
                    Some(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                } else {
                    None
                }
            })
            .collect();
        Self(floats)
    }

    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Bounded {
            max_size: 16384, // 4096 floats max (4 bytes each)
            is_fixed_size: false,
        };
}

// ========== Thread-Local Storage ==========

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    // Main data store: key = "collection:id", value = JSON
    static DATA: RefCell<StableBTreeMap<StorableString, StorableValue, StableMemory>> =
        RefCell::new(
            StableBTreeMap::init(
                MEMORY_MANAGER.with(|m| m.borrow().get(MEMORY_ID_DATA))
            )
        );

    // Vector store for embeddings: key = id, value = vector
    static VECTORS: RefCell<StableBTreeMap<StorableString, StorableVector, StableMemory>> =
        RefCell::new(
            StableBTreeMap::init(
                MEMORY_MANAGER.with(|m| m.borrow().get(MEMORY_ID_VECTORS))
            )
        );

    // In-memory cache (not persisted)
    static CACHE: RefCell<HashMap<String, Value>> = RefCell::new(HashMap::new());

    // Vector dimension
    static VECTOR_DIM: RefCell<usize> = const { RefCell::new(384) };
}

// ========== ICP Memory Storage (matching IStorage interface) ==========

/// ICP-adapted storage matching plugin-inmemorydb's MemoryStorage interface
pub struct IcpMemoryStorage;

impl IcpMemoryStorage {
    fn make_key(collection: &str, id: &str) -> StorableString {
        StorableString(format!("{}:{}", collection, id))
    }

    fn parse_key(key: &str) -> Option<(&str, &str)> {
        key.split_once(':')
    }

    // ========== IStorage Methods ==========

    pub fn init() -> StorageResult<()> {
        Ok(())
    }

    pub fn close() -> StorageResult<()> {
        // Clear cache only (stable data persists)
        CACHE.with(|c| c.borrow_mut().clear());
        Ok(())
    }

    pub fn is_ready() -> bool {
        true
    }

    pub fn get(collection: &str, id: &str) -> StorageResult<Option<Value>> {
        let key = Self::make_key(collection, id);
        DATA.with(|data| Ok(data.borrow().get(&key).map(|v| v.0.clone())))
    }

    pub fn get_all(collection: &str) -> StorageResult<Vec<Value>> {
        let prefix = format!("{}:", collection);
        let mut results = Vec::new();

        DATA.with(|data| {
            for (key, value) in data.borrow().iter() {
                if key.0.starts_with(&prefix) {
                    results.push(value.0.clone());
                }
            }
        });

        Ok(results)
    }

    /// Get items matching a predicate function
    pub fn get_where<F>(collection: &str, predicate: F) -> StorageResult<Vec<Value>>
    where
        F: Fn(&Value) -> bool,
    {
        let prefix = format!("{}:", collection);
        let mut results = Vec::new();

        DATA.with(|data| {
            for (key, value) in data.borrow().iter() {
                if key.0.starts_with(&prefix) && predicate(&value.0) {
                    results.push(value.0.clone());
                }
            }
        });

        Ok(results)
    }

    pub fn set(collection: &str, id: &str, data: Value) -> StorageResult<()> {
        let key = Self::make_key(collection, id);
        DATA.with(|d| {
            d.borrow_mut().insert(key, StorableValue(data));
        });
        Ok(())
    }

    pub fn delete(collection: &str, id: &str) -> StorageResult<bool> {
        let key = Self::make_key(collection, id);
        DATA.with(|data| Ok(data.borrow_mut().remove(&key).is_some()))
    }

    pub fn delete_many(collection: &str, ids: &[String]) -> StorageResult<()> {
        for id in ids {
            Self::delete(collection, id)?;
        }
        Ok(())
    }

    pub fn delete_where<F>(collection: &str, predicate: F) -> StorageResult<()>
    where
        F: Fn(&Value) -> bool,
    {
        let prefix = format!("{}:", collection);
        let mut to_delete = Vec::new();

        DATA.with(|data| {
            for (key, value) in data.borrow().iter() {
                if key.0.starts_with(&prefix) && predicate(&value.0) {
                    to_delete.push(key.clone());
                }
            }
        });

        DATA.with(|data| {
            for key in to_delete {
                data.borrow_mut().remove(&key);
            }
        });

        Ok(())
    }

    pub fn count<F>(collection: &str, predicate: Option<F>) -> StorageResult<usize>
    where
        F: Fn(&Value) -> bool,
    {
        let prefix = format!("{}:", collection);
        let mut count = 0;

        DATA.with(|data| {
            for (key, value) in data.borrow().iter() {
                if key.0.starts_with(&prefix) {
                    match &predicate {
                        Some(pred) if !pred(&value.0) => continue,
                        _ => count += 1,
                    }
                }
            }
        });

        Ok(count)
    }

    pub fn clear() -> StorageResult<()> {
        DATA.with(|data| {
            // Can't clear StableBTreeMap directly, iterate and remove
            let keys: Vec<_> = data.borrow().iter().map(|(k, _)| k.clone()).collect();
            for key in keys {
                data.borrow_mut().remove(&key);
            }
        });
        VECTORS.with(|v| {
            let keys: Vec<_> = v.borrow().iter().map(|(k, _)| k.clone()).collect();
            for key in keys {
                v.borrow_mut().remove(&key);
            }
        });
        Ok(())
    }
}

// ========== ICP Vector Storage (matching IVectorStorage interface) ==========

/// ICP-adapted vector storage for semantic search
pub struct IcpVectorStorage;

impl IcpVectorStorage {
    pub fn init(dimension: usize) -> StorageResult<()> {
        VECTOR_DIM.with(|d| *d.borrow_mut() = dimension);
        Ok(())
    }

    pub fn add(id: &str, vector: &[f32]) -> StorageResult<()> {
        let dimension = VECTOR_DIM.with(|d| *d.borrow());
        if vector.len() != dimension {
            return Err(StorageError::DimensionMismatch {
                expected: dimension,
                actual: vector.len(),
            });
        }

        VECTORS.with(|v| {
            v.borrow_mut()
                .insert(StorableString(id.to_string()), StorableVector(vector.to_vec()));
        });
        Ok(())
    }

    pub fn remove(id: &str) -> StorageResult<()> {
        VECTORS.with(|v| {
            v.borrow_mut().remove(&StorableString(id.to_string()));
        });
        Ok(())
    }

    pub fn search(query: &[f32], k: usize, threshold: f32) -> StorageResult<Vec<VectorSearchResult>> {
        let dimension = VECTOR_DIM.with(|d| *d.borrow());
        if query.len() != dimension {
            return Err(StorageError::DimensionMismatch {
                expected: dimension,
                actual: query.len(),
            });
        }

        let mut results = Vec::new();

        VECTORS.with(|vectors| {
            for (key, vector) in vectors.borrow().iter() {
                let similarity = cosine_similarity(query, &vector.0);
                if similarity >= threshold {
                    results.push(VectorSearchResult {
                        id: key.0.clone(),
                        distance: 1.0 - similarity,
                        similarity,
                    });
                }
            }
        });

        // Sort by similarity descending
        results.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap());
        results.truncate(k);

        Ok(results)
    }

    pub fn clear() -> StorageResult<()> {
        VECTORS.with(|v| {
            let keys: Vec<_> = v.borrow().iter().map(|(k, _)| k.clone()).collect();
            for key in keys {
                v.borrow_mut().remove(&key);
            }
        });
        Ok(())
    }

    pub fn size() -> usize {
        VECTORS.with(|v| v.borrow().len() as usize)
    }
}

/// Cosine similarity between two vectors
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }

    let mut dot_product = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for i in 0..a.len() {
        dot_product += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let magnitude = norm_a.sqrt() * norm_b.sqrt();
    if magnitude == 0.0 {
        return 0.0;
    }

    dot_product / magnitude
}

// ========== ICP Database Adapter (matching InMemoryDatabaseAdapter) ==========

/// ICP Database Adapter matching plugin-inmemorydb's InMemoryDatabaseAdapter interface
pub struct IcpDatabaseAdapter {
    agent_id: String,
    embedding_dimension: usize,
    ready: bool,
}

impl IcpDatabaseAdapter {
    pub fn new(agent_id: String) -> Self {
        Self {
            agent_id,
            embedding_dimension: 384,
            ready: false,
        }
    }

    pub fn init(&mut self) -> StorageResult<()> {
        IcpMemoryStorage::init()?;
        IcpVectorStorage::init(self.embedding_dimension)?;
        self.ready = true;
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn close(&mut self) -> StorageResult<()> {
        IcpVectorStorage::clear()?;
        IcpMemoryStorage::close()?;
        self.ready = false;
        Ok(())
    }

    pub fn ensure_embedding_dimension(&mut self, dimension: usize) -> StorageResult<()> {
        if self.embedding_dimension != dimension {
            self.embedding_dimension = dimension;
            IcpVectorStorage::init(dimension)?;
        }
        Ok(())
    }

    // ========== Agent Operations ==========

    pub fn get_agent(&self, agent_id: &str) -> StorageResult<Option<Value>> {
        IcpMemoryStorage::get(COLLECTIONS::AGENTS, agent_id)
    }

    pub fn get_agents(&self) -> StorageResult<Vec<Value>> {
        IcpMemoryStorage::get_all(COLLECTIONS::AGENTS)
    }

    pub fn create_agent(&self, agent: Value) -> StorageResult<bool> {
        let id = agent.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
        match id {
            Some(id) => {
                IcpMemoryStorage::set(COLLECTIONS::AGENTS, &id, agent)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub fn update_agent(&self, agent_id: &str, agent: Value) -> StorageResult<bool> {
        let existing = self.get_agent(agent_id)?;
        match existing {
            Some(mut existing) => {
                if let (Some(existing_obj), Some(agent_obj)) =
                    (existing.as_object_mut(), agent.as_object())
                {
                    for (k, v) in agent_obj {
                        existing_obj.insert(k.clone(), v.clone());
                    }
                }
                IcpMemoryStorage::set(COLLECTIONS::AGENTS, agent_id, existing)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub fn delete_agent(&self, agent_id: &str) -> StorageResult<bool> {
        IcpMemoryStorage::delete(COLLECTIONS::AGENTS, agent_id)
    }

    // ========== Memory Operations (matching plugin-inmemorydb exactly) ==========

    pub fn get_memories(
        &self,
        entity_id: Option<&str>,
        agent_id: Option<&str>,
        room_id: Option<&str>,
        world_id: Option<&str>,
        table_name: &str,
        count: Option<usize>,
        offset: Option<usize>,
        _unique: Option<bool>,
    ) -> StorageResult<Vec<Value>> {
        let entity_id_owned = entity_id.map(|s| s.to_string());
        let agent_id_owned = agent_id.map(|s| s.to_string());
        let room_id_owned = room_id.map(|s| s.to_string());
        let world_id_owned = world_id.map(|s| s.to_string());
        let table_name_owned = table_name.to_string();

        let mut memories = IcpMemoryStorage::get_where(COLLECTIONS::MEMORIES, |m| {
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
                if metadata.get("type").and_then(|v| v.as_str()) != Some(&table_name_owned) {
                    return false;
                }
            }
            true
        })?;

        // Sort by createdAt descending
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

    pub fn get_memory_by_id(&self, id: &str) -> StorageResult<Option<Value>> {
        IcpMemoryStorage::get(COLLECTIONS::MEMORIES, id)
    }

    pub fn search_memories(
        &self,
        table_name: &str,
        embedding: &[f32],
        match_threshold: Option<f32>,
        count: Option<usize>,
        room_id: Option<&str>,
        world_id: Option<&str>,
        entity_id: Option<&str>,
        unique: Option<bool>,
    ) -> StorageResult<Vec<Value>> {
        let threshold = match_threshold.unwrap_or(0.5);
        let k = count.unwrap_or(10);

        let results = IcpVectorStorage::search(embedding, k * 2, threshold)?;

        let mut memories = Vec::new();
        for result in results {
            let memory = self.get_memory_by_id(&result.id)?;
            if let Some(mut memory) = memory {
                // Filter by table_name
                if let Some(metadata) = memory.get("metadata") {
                    if metadata.get("type").and_then(|v| v.as_str()) != Some(table_name) {
                        continue;
                    }
                }
                // Filter by room_id
                if let Some(rid) = room_id {
                    if memory.get("roomId").and_then(|v| v.as_str()) != Some(rid) {
                        continue;
                    }
                }
                // Filter by world_id
                if let Some(wid) = world_id {
                    if memory.get("worldId").and_then(|v| v.as_str()) != Some(wid) {
                        continue;
                    }
                }
                // Filter by entity_id
                if let Some(eid) = entity_id {
                    if memory.get("entityId").and_then(|v| v.as_str()) != Some(eid) {
                        continue;
                    }
                }
                // Filter by unique
                if unique == Some(true) && memory.get("unique") != Some(&json!(true)) {
                    continue;
                }

                // Add similarity score
                memory
                    .as_object_mut()
                    .unwrap()
                    .insert("similarity".to_string(), json!(result.similarity));
                memories.push(memory);
            }
        }

        Ok(memories.into_iter().take(k).collect())
    }

    pub fn create_memory(
        &self,
        memory: Value,
        table_name: &str,
        unique: bool,
    ) -> StorageResult<String> {
        let id = memory
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(generate_uuid);

        let now = now_millis();

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
            memory.get("createdAt").cloned().unwrap_or_else(|| json!(now)),
        );

        // Add table_name to metadata
        let mut metadata = memory.get("metadata").cloned().unwrap_or_else(|| json!({}));
        metadata
            .as_object_mut()
            .unwrap()
            .insert("type".to_string(), json!(table_name));
        obj.insert("metadata".to_string(), metadata);

        IcpMemoryStorage::set(COLLECTIONS::MEMORIES, &id, stored_memory)?;

        // Add embedding to vector store if present
        if let Some(embedding) = memory.get("embedding").and_then(|v| v.as_array()) {
            let embedding: Vec<f32> = embedding
                .iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect();
            if !embedding.is_empty() {
                IcpVectorStorage::add(&id, &embedding)?;
            }
        }

        Ok(id)
    }

    pub fn delete_memory(&self, memory_id: &str) -> StorageResult<()> {
        IcpMemoryStorage::delete(COLLECTIONS::MEMORIES, memory_id)?;
        IcpVectorStorage::remove(memory_id)?;
        Ok(())
    }

    // ========== Room Operations ==========

    pub fn create_room(&self, room: Value) -> StorageResult<String> {
        let id = room
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(generate_uuid);

        let mut stored = room;
        stored.as_object_mut().unwrap().insert("id".to_string(), json!(id));

        IcpMemoryStorage::set(COLLECTIONS::ROOMS, &id, stored)?;
        Ok(id)
    }

    pub fn get_room(&self, id: &str) -> StorageResult<Option<Value>> {
        IcpMemoryStorage::get(COLLECTIONS::ROOMS, id)
    }

    pub fn get_rooms_by_ids(&self, room_ids: &[String]) -> StorageResult<Option<Vec<Value>>> {
        let mut rooms = Vec::new();
        for id in room_ids {
            if let Some(room) = IcpMemoryStorage::get(COLLECTIONS::ROOMS, id)? {
                rooms.push(room);
            }
        }
        if rooms.is_empty() {
            Ok(None)
        } else {
            Ok(Some(rooms))
        }
    }

    pub fn delete_room(&self, room_id: &str) -> StorageResult<()> {
        IcpMemoryStorage::delete(COLLECTIONS::ROOMS, room_id)?;

        // Delete participants for this room
        let room_id_owned = room_id.to_string();
        IcpMemoryStorage::delete_where(COLLECTIONS::PARTICIPANTS, |p| {
            p.get("roomId").and_then(|v| v.as_str()) == Some(&room_id_owned)
        })?;

        // Delete memories for this room
        let room_id_owned = room_id.to_string();
        IcpMemoryStorage::delete_where(COLLECTIONS::MEMORIES, |m| {
            m.get("roomId").and_then(|v| v.as_str()) == Some(&room_id_owned)
        })?;

        Ok(())
    }

    // ========== Entity Operations ==========

    pub fn create_entity(&self, entity: Value) -> StorageResult<String> {
        let id = entity
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(generate_uuid);

        let mut stored = entity;
        stored.as_object_mut().unwrap().insert("id".to_string(), json!(id));

        IcpMemoryStorage::set(COLLECTIONS::ENTITIES, &id, stored)?;
        Ok(id)
    }

    pub fn get_entity(&self, id: &str) -> StorageResult<Option<Value>> {
        IcpMemoryStorage::get(COLLECTIONS::ENTITIES, id)
    }

    // ========== Cache Operations ==========

    pub fn get_cache(&self, key: &str) -> StorageResult<Option<Value>> {
        let cached = IcpMemoryStorage::get(COLLECTIONS::CACHE, key)?;
        if let Some(cached) = cached {
            if let Some(expires_at) = cached.get("expiresAt").and_then(|v| v.as_i64()) {
                let now = now_millis();
                if now > expires_at {
                    IcpMemoryStorage::delete(COLLECTIONS::CACHE, key)?;
                    return Ok(None);
                }
            }
            return Ok(cached.get("value").cloned());
        }
        Ok(None)
    }

    pub fn set_cache(&self, key: &str, value: Value) -> StorageResult<bool> {
        IcpMemoryStorage::set(COLLECTIONS::CACHE, key, json!({ "value": value }))?;
        Ok(true)
    }

    pub fn delete_cache(&self, key: &str) -> StorageResult<bool> {
        IcpMemoryStorage::delete(COLLECTIONS::CACHE, key)
    }

    // ========== Utility ==========

    pub fn memory_count(&self) -> u64 {
        IcpMemoryStorage::count::<fn(&Value) -> bool>(COLLECTIONS::MEMORIES, None)
            .unwrap_or(0) as u64
    }
}

// ========== Global Adapter (matching plugin-inmemorydb pattern) ==========

thread_local! {
    static ADAPTER: RefCell<Option<IcpDatabaseAdapter>> = const { RefCell::new(None) };
}

/// Create or get the database adapter (matching plugin-inmemorydb's create_database_adapter)
pub fn create_database_adapter(agent_id: &str) -> IcpDatabaseAdapter {
    ADAPTER.with(|a| {
        let mut adapter = a.borrow_mut();
        if adapter.is_none() {
            let mut new_adapter = IcpDatabaseAdapter::new(agent_id.to_string());
            let _ = new_adapter.init();
            *adapter = Some(new_adapter);
        }
        adapter.clone().unwrap()
    })
}

/// Get the current adapter if initialized
pub fn get_adapter() -> Option<IcpDatabaseAdapter> {
    ADAPTER.with(|a| a.borrow().clone())
}

impl Clone for IcpDatabaseAdapter {
    fn clone(&self) -> Self {
        Self {
            agent_id: self.agent_id.clone(),
            embedding_dimension: self.embedding_dimension,
            ready: self.ready,
        }
    }
}
