//! Type definitions for plugin-inmemorydb
//!
//! Pure in-memory, ephemeral storage - no persistence.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Error type for storage operations
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("Storage not ready")]
    NotReady,
    #[error("Item not found: {0}")]
    NotFound(String),
    #[error("Dimension mismatch: expected {expected}, got {actual}")]
    DimensionMismatch { expected: usize, actual: usize },
    #[error("Serialization error: {0}")]
    Serialization(String),
    #[error("Other error: {0}")]
    Other(String),
}

/// Result type for storage operations
pub type StorageResult<T> = Result<T, StorageError>;

/// Storage interface for in-memory data
#[async_trait]
pub trait IStorage: Send + Sync {
    /// Initialize the storage
    async fn init(&self) -> StorageResult<()>;

    /// Close the storage (clears all data)
    async fn close(&self) -> StorageResult<()>;

    /// Check if storage is ready
    async fn is_ready(&self) -> bool;

    /// Get an item by collection and id
    async fn get(&self, collection: &str, id: &str) -> StorageResult<Option<serde_json::Value>>;

    /// Get all items in a collection
    async fn get_all(&self, collection: &str) -> StorageResult<Vec<serde_json::Value>>;

    /// Get items by a filter function
    async fn get_where(
        &self,
        collection: &str,
        predicate: Box<dyn Fn(&serde_json::Value) -> bool + Send>,
    ) -> StorageResult<Vec<serde_json::Value>>;

    /// Set an item in a collection
    async fn set(&self, collection: &str, id: &str, data: serde_json::Value) -> StorageResult<()>;

    /// Delete an item from a collection
    async fn delete(&self, collection: &str, id: &str) -> StorageResult<bool>;

    /// Delete multiple items from a collection
    async fn delete_many(&self, collection: &str, ids: &[String]) -> StorageResult<()>;

    /// Delete all items in a collection matching a predicate
    async fn delete_where(
        &self,
        collection: &str,
        predicate: Box<dyn Fn(&serde_json::Value) -> bool + Send>,
    ) -> StorageResult<()>;

    /// Count items in a collection
    async fn count(
        &self,
        collection: &str,
        predicate: Option<Box<dyn Fn(&serde_json::Value) -> bool + Send>>,
    ) -> StorageResult<usize>;

    /// Clear all data from all collections
    async fn clear(&self) -> StorageResult<()>;
}

/// Vector storage interface for HNSW-based similarity search
#[async_trait]
pub trait IVectorStorage: Send + Sync {
    /// Initialize the vector storage
    async fn init(&self, dimension: usize) -> StorageResult<()>;

    /// Add a vector with associated id
    async fn add(&self, id: &str, vector: &[f32]) -> StorageResult<()>;

    /// Remove a vector by id
    async fn remove(&self, id: &str) -> StorageResult<()>;

    /// Search for nearest neighbors
    async fn search(
        &self,
        query: &[f32],
        k: usize,
        threshold: f32,
    ) -> StorageResult<Vec<VectorSearchResult>>;

    /// Clear all vectors from the index
    async fn clear(&self) -> StorageResult<()>;
}

/// Result of a vector similarity search
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub distance: f32,
    pub similarity: f32,
}

/// Collections used by the adapter
pub struct COLLECTIONS;

impl COLLECTIONS {
    pub const AGENTS: &'static str = "agents";
    pub const ENTITIES: &'static str = "entities";
    pub const MEMORIES: &'static str = "memories";
    pub const ROOMS: &'static str = "rooms";
    pub const WORLDS: &'static str = "worlds";
    pub const COMPONENTS: &'static str = "components";
    pub const RELATIONSHIPS: &'static str = "relationships";
    pub const PARTICIPANTS: &'static str = "participants";
    pub const TASKS: &'static str = "tasks";
    pub const CACHE: &'static str = "cache";
    pub const LOGS: &'static str = "logs";
    pub const EMBEDDINGS: &'static str = "embeddings";
}

