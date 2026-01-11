//! elizaOS Shell Plugin - Shell command execution with directory restrictions and history tracking.
//!
//! This crate provides a secure way to execute shell commands within a restricted directory,
//! with command history tracking and file operation detection.

mod error;
mod types;
mod path_utils;
mod service;

pub use error::{ShellError, Result};
pub use types::{
    CommandResult,
    CommandHistoryEntry,
    FileOperation,
    FileOperationType,
    ShellConfig,
    ShellConfigBuilder,
};
pub use path_utils::{
    validate_path,
    is_safe_command,
    extract_base_command,
    is_forbidden_command,
    DEFAULT_FORBIDDEN_COMMANDS,
};
pub use service::ShellService;

/// Re-export for convenience
pub mod prelude {
    pub use crate::{
        ShellConfig,
        ShellConfigBuilder,
        ShellService,
        CommandResult,
        CommandHistoryEntry,
        FileOperation,
        FileOperationType,
        ShellError,
        Result,
    };
}


