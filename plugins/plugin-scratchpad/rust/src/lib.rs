#![allow(missing_docs)]
//! elizaOS Plugin Scratchpad – Rust Implementation
//!
//! This crate provides file-based persistent memory storage for elizaOS,
//! with markdown frontmatter metadata and TF-IDF-based search.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Actions
//!
//! - `SCRATCHPAD_WRITE`: Create a new scratchpad entry
//! - `SCRATCHPAD_READ`: Read a specific entry by ID
//! - `SCRATCHPAD_SEARCH`: Search entries by content
//! - `SCRATCHPAD_LIST`: List all entries
//! - `SCRATCHPAD_DELETE`: Delete an entry
//! - `SCRATCHPAD_APPEND`: Append content to an existing entry
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_scratchpad::{ScratchpadService, ScratchpadConfig};
//! use elizaos_plugin_scratchpad::types::ScratchpadWriteOptions;
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = ScratchpadConfig::default();
//!     let service = ScratchpadService::new(config);
//!
//!     let entry = service.write("My Note", "Hello world!", &ScratchpadWriteOptions::default()).await?;
//!     println!("Created: {} ({})", entry.title, entry.id);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod actions;
pub mod config;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

// Re-export commonly used types for convenience
pub use config::ScratchpadConfig;
pub use error::{Result, ScratchpadError};
pub use service::{create_scratchpad_service, ScratchpadService};
pub use types::{
    ScratchpadEntry, ScratchpadReadOptions, ScratchpadSearchOptions, ScratchpadSearchResult,
    ScratchpadWriteOptions,
};

/// Plugin metadata
pub const PLUGIN_NAME: &str = "scratchpad";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "File-based memory storage for persistent notes and memories that can be written, read, searched, and managed across sessions.";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Creates a runtime-native elizaOS plugin (`elizaos::Plugin`).
///
/// This is the interface expected by the Rust AgentRuntime plugin system.
pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(PLUGIN_NAME, PLUGIN_DESCRIPTION)
}
