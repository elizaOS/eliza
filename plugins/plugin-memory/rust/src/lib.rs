#![allow(missing_docs)]
//! elizaOS Plugin Memory - Rust Implementation
//!
//! This crate provides memory management capabilities for elizaOS agents,
//! including conversation summarization and persistent fact extraction.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_memory::{MemoryService, MemoryConfig, LongTermMemoryCategory};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = MemoryConfig::default();
//!     let service = MemoryService::new(config);
//!
//!     // Store a long-term memory
//!     let memory = service.store_long_term_memory(
//!         agent_id,
//!         entity_id,
//!         LongTermMemoryCategory::Semantic,
//!         "User is a Rust developer".to_string(),
//!         0.95,
//!         Some("conversation".to_string()),
//!         None,
//!         None,
//!     ).await?;
//!
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Import directly from submodules:
// - config::MemoryConfig
// - error::{MemoryError, Result}
// - service::MemoryService
// - types::{LongTermMemory, LongTermMemoryCategory, MemoryExtraction, etc.}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "memory";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Advanced memory management with conversation summarization and long-term persistent memory";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");







