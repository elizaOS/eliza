//! Pure in-memory, ephemeral database storage for elizaOS
//!
//! This crate provides a pure in-memory database that is completely ephemeral.
//! All data is lost when the process restarts or when close() is called.

pub mod adapter;
pub mod hnsw;
pub mod storage;
pub mod types;

pub use adapter::InMemoryDatabaseAdapter;
pub use hnsw::EphemeralHNSW;
pub use storage::MemoryStorage;
pub use types::{IStorage, IVectorStorage, VectorSearchResult, COLLECTIONS};

use parking_lot::Mutex;
use std::sync::Arc;

/// Global singleton for storage (shared across all agents in the same process)
static GLOBAL_STORAGE: Mutex<Option<Arc<MemoryStorage>>> = Mutex::new(None);

/// Creates an in-memory database adapter
///
/// # Arguments
/// * `agent_id` - The agent ID
///
/// # Returns
/// The database adapter
pub fn create_database_adapter(agent_id: &str) -> InMemoryDatabaseAdapter {
    let mut global = GLOBAL_STORAGE.lock();
    let storage = global
        .get_or_insert_with(|| Arc::new(MemoryStorage::new()))
        .clone();
    InMemoryDatabaseAdapter::new(storage, agent_id.to_string())
}

/// Plugin definition for elizaOS
pub struct InMemoryDbPlugin;

impl InMemoryDbPlugin {
    pub const NAME: &'static str = "@elizaos/plugin-inmemorydb";
    pub const DESCRIPTION: &'static str =
        "Pure in-memory, ephemeral database storage for elizaOS - no persistence";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_adapter() {
        let mut adapter = create_database_adapter("test-agent");
        adapter.init().await.unwrap();
        assert!(adapter.is_ready().await);
    }
}

