#![allow(clippy::too_many_arguments)]

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

static GLOBAL_STORAGE: Mutex<Option<Arc<MemoryStorage>>> = Mutex::new(None);

pub fn create_database_adapter(agent_id: &str) -> InMemoryDatabaseAdapter {
    let mut global = GLOBAL_STORAGE.lock();
    let storage = global
        .get_or_insert_with(|| Arc::new(MemoryStorage::new()))
        .clone();
    InMemoryDatabaseAdapter::new(storage, agent_id.to_string())
}

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
