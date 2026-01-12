#![allow(missing_docs)]
//! elizaOS Shell Plugin - Shell command execution with directory restrictions and history tracking.
//!
//! This crate provides a secure way to execute shell commands within a restricted directory,
//! with command history tracking and file operation detection.

mod error;
mod path_utils;
mod service;
mod types;

// Re-export public API
pub use error::{Result, ShellError};
pub use path_utils::{
    extract_base_command, is_forbidden_command, is_safe_command, validate_path,
    DEFAULT_FORBIDDEN_COMMANDS,
};
pub use service::ShellService;
pub use types::{
    CommandHistoryEntry, CommandResult, FileOperation, FileOperationType, ShellConfig,
    ShellConfigBuilder,
};

/// Prelude module - convenient re-exports
pub mod prelude {
    pub use crate::error::{Result, ShellError};
    pub use crate::service::ShellService;
    pub use crate::types::{CommandHistoryEntry, CommandResult, FileOperation, ShellConfig};
}
