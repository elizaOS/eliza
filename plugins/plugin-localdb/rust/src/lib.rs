#![allow(missing_docs)]

pub mod adapter;
pub mod hnsw;
pub mod storage;

pub use adapter::LocalDatabaseAdapter;
pub use hnsw::SimpleHNSW;
pub use storage::JsonStorage;

pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new("localdb", "Simple JSON-based local database storage")
}
