#![allow(missing_docs)]
//! elizaOS Plugin SQL - Rust Implementation
//!
//! This crate provides database adapters for elizaOS, supporting both PGLite (for WASM/browser)
//! and PostgreSQL (for native server deployments).
//!
//! # Features
//!
//! - `native` (default): Enables PostgreSQL adapter with sqlx
//! - `wasm`: Enables PGLite adapter with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_sql::{PostgresAdapter, DatabaseAdapter};
//! use elizaos::UUID;
//!
//! async fn example() -> anyhow::Result<()> {
//!     let agent_id = UUID::new_v4();
//!     let adapter = PostgresAdapter::new("postgres://localhost/eliza", &agent_id).await?;
//!     adapter.init().await?;
//!     
//!     let agent = adapter.get_agent(&agent_id).await?;
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]

pub mod base;
#[cfg(feature = "native")]
pub mod migration;
pub mod schema;

#[cfg(feature = "native")]
pub mod postgres;

#[cfg(feature = "wasm")]
pub mod pglite;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export core types
pub use elizaos::types::*;

// Re-export adapters
pub use base::DatabaseAdapter;

#[cfg(feature = "native")]
pub use postgres::PostgresAdapter;

#[cfg(feature = "wasm")]
pub use pglite::PgLiteAdapter;

/// Plugin definition for elizaOS
pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(
        "sql",
        "SQL database plugin with PostgreSQL and PGLite support",
    )
}
