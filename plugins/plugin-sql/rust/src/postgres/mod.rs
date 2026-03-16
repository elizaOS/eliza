#![allow(missing_docs)]
//! PostgreSQL adapter for elizaOS
//!
//! This module provides the PostgreSQL database adapter implementation.

mod adapter;
mod manager;

pub use adapter::PostgresAdapter;
pub use manager::PostgresConnectionManager;
