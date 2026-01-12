#![allow(missing_docs)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

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

pub type StorageResult<T> = Result<T, StorageError>;

pub type PredicateFn = Box<dyn Fn(&serde_json::Value) -> bool + Send + Sync + 'static>;

#[async_trait]
pub trait IStorage: Send + Sync {
    async fn init(&self) -> StorageResult<()>;
    async fn close(&self) -> StorageResult<()>;
    async fn is_ready(&self) -> bool;
    async fn get(&self, collection: &str, id: &str) -> StorageResult<Option<serde_json::Value>>;
    async fn get_all(&self, collection: &str) -> StorageResult<Vec<serde_json::Value>>;
    async fn get_where(
        &self,
        collection: &str,
        predicate: PredicateFn,
    ) -> StorageResult<Vec<serde_json::Value>>;
    async fn set(&self, collection: &str, id: &str, data: serde_json::Value) -> StorageResult<()>;
    async fn delete(&self, collection: &str, id: &str) -> StorageResult<bool>;
    async fn delete_many(&self, collection: &str, ids: &[String]) -> StorageResult<()>;
    async fn delete_where(&self, collection: &str, predicate: PredicateFn) -> StorageResult<()>;
    async fn count(&self, collection: &str, predicate: Option<PredicateFn>)
        -> StorageResult<usize>;
    async fn clear(&self) -> StorageResult<()>;
}

#[async_trait]
pub trait IVectorStorage: Send + Sync {
    async fn init(&self, dimension: usize) -> StorageResult<()>;
    async fn add(&self, id: &str, vector: &[f32]) -> StorageResult<()>;
    async fn remove(&self, id: &str) -> StorageResult<()>;
    async fn search(
        &self,
        query: &[f32],
        k: usize,
        threshold: f32,
    ) -> StorageResult<Vec<VectorSearchResult>>;
    async fn clear(&self) -> StorageResult<()>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub distance: f32,
    pub similarity: f32,
}

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
