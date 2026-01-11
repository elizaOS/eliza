#![allow(missing_docs)]
//! elizaOS Plugin Todo - Rust Implementation
//!
//! This crate provides a Todo task management system for elizaOS,
//! supporting daily recurring tasks, one-off tasks with priorities,
//! and aspirational goals.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_todo::{TodoClient, TodoConfig, TaskType, Priority};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = TodoConfig::from_env()?;
//!     let client = TodoClient::new(config)?;
//!
//!     let todo = client.create_todo(CreateTodoParams {
//!         name: "Finish report".to_string(),
//!         task_type: TaskType::OneOff,
//!         priority: Some(Priority::High),
//!         ..Default::default()
//!     }).await?;
//!
//!     println!("Created: {}", todo.name);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod types;
pub mod error;
pub mod config;
pub mod data_service;
pub mod cache_manager;
pub mod notification_manager;
pub mod reminder_service;
pub mod client;

#[cfg(feature = "wasm")]
pub mod wasm;

// Import directly from submodules:
// - client::TodoClient
// - config::TodoConfig
// - error::{TodoError, Result}
// - types::{Todo, TodoMetadata, CreateTodoParams, TaskType, Priority, etc.}
// - data_service::TodoDataService
// - cache_manager::CacheManager
// - notification_manager::NotificationManager
// - reminder_service::ReminderService

/// Create a TodoClient from environment variables.
///
/// # Errors
///
/// Returns an error if configuration is invalid.
pub fn create_client_from_env() -> Result<TodoClient> {
    let config = TodoConfig::from_env()?;
    TodoClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "todo";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Todo task management with daily recurring and one-off tasks";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");







