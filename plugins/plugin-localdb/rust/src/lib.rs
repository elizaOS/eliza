#![allow(missing_docs)]
//! elizaOS Plugin LocalDB - Simple JSON-based storage for Rust
//!
//! This crate provides a lightweight, file-based database adapter for elizaOS
//! using plain JSON files for storage. No external database dependencies required.
//!
//! # Features
//!
//! - Zero configuration - no database setup required
//! - JSON file-based storage using serde_json
//! - Simple HNSW implementation for vector search
//! - Cross-platform file system operations
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_localdb::{LocalDatabaseAdapter, JsonStorage};
//!
//! async fn example() -> anyhow::Result<()> {
//!     let storage = JsonStorage::new("./data")?;
//!     let adapter = LocalDatabaseAdapter::new(storage, "agent-id".to_string());
//!     adapter.init().await?;
//!     
//!     // Use the adapter...
//!     
//!     adapter.close().await?;
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]

pub mod storage;
pub mod hnsw;
pub mod adapter;

pub use storage::JsonStorage;
pub use hnsw::SimpleHNSW;
pub use adapter::LocalDatabaseAdapter;

/// Plugin definition for elizaOS
pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(
        "localdb",
        "Simple JSON-based local database storage",
    )
}
