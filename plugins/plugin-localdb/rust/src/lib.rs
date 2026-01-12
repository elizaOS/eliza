#![allow(missing_docs)]

pub mod storage;
pub mod hnsw;
pub mod adapter;

pub use storage::JsonStorage;
pub use hnsw::SimpleHNSW;
pub use adapter::LocalDatabaseAdapter;

pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(
        "localdb",
        "Simple JSON-based local database storage",
    )
}
