#![allow(missing_docs)]
//! elizaOS Shell Plugin - Shell command execution with directory restrictions and history tracking.
//!
//! This crate provides a secure way to execute shell commands within a restricted directory,
//! with command history tracking and file operation detection.

mod error;
mod types;
mod path_utils;
mod service;

// Import directly from submodules:
// - error::{ShellError, Result}
// - types::{CommandResult, CommandHistoryEntry, FileOperation, etc.}
// - path_utils::{validate_path, is_safe_command, etc.}
// - service::ShellService

/// Prelude module - import directly from specific modules
pub mod prelude {}







