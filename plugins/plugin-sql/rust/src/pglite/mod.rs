#![allow(missing_docs)]
//! PGLite adapter for elizaOS
//!
//! This module provides the PGLite database adapter implementation for WASM environments.

#[cfg(feature = "wasm")]
mod adapter;
#[cfg(feature = "wasm")]
mod manager;

#[cfg(feature = "wasm")]
pub use adapter::PgLiteAdapter;
#[cfg(feature = "wasm")]
pub use manager::PgLiteManager;
