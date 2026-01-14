#![allow(missing_docs)]
//! Migration system for elizaOS plugin-sql (Rust).
//!
//! This module provides runtime migration capabilities similar to the TypeScript
//! RuntimeMigrator, supporting plugin-based schema migrations and automatic
//! schema detection.
//!
//! # Features
//!
//! - Plugin-based schema migrations
//! - Schema snapshot tracking
//! - Migration history tracking
//! - Automatic schema detection
//! - Transaction-safe migrations
//! - Plugin schema namespacing

pub mod schema_namespace;
pub mod service;
pub mod storage;
pub mod tracker;

pub use schema_namespace::{derive_schema_name, SchemaNamespaceManager};
pub use service::MigrationService;
pub use storage::{JournalStorage, SnapshotStorage};
pub use tracker::MigrationTracker;
