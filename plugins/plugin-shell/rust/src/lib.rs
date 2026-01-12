#![allow(missing_docs)]
//! elizaOS Shell Plugin - Shell command execution with directory restrictions and history tracking.
//!
//! This crate provides a secure way to execute shell commands within a restricted directory,
//! with command history tracking and file operation detection.
//!
//! # Features
//!
//! - Execute shell commands within a restricted directory
//! - Track command history per conversation
//! - Detect file operations (create, write, delete, move, copy)
//! - Security validation (forbidden commands, path traversal prevention)
//!
//! # Actions
//!
//! - `EXECUTE_COMMAND`: Execute a shell command
//! - `CLEAR_HISTORY`: Clear command history for a conversation
//!
//! # Providers
//!
//! - `SHELL_HISTORY`: Provides recent command history and file operations

use async_trait::async_trait;
use serde_json::Value;

mod error;
mod path_utils;
mod service;
mod types;

pub mod actions;
pub mod providers;

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

// Re-export actions and providers
pub use actions::{ClearHistoryAction, ExecuteCommandAction, get_shell_actions};
pub use providers::{ShellHistoryProvider, get_shell_providers};

/// Plugin metadata
pub const PLUGIN_NAME: &str = "shell";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Execute shell commands within a restricted directory with history tracking";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Action example for documentation and testing.
#[derive(Debug, Clone)]
pub struct ActionExample {
    /// Example user message.
    pub user_message: String,
    /// Expected agent response.
    pub agent_response: String,
}

/// Result of an action execution.
#[derive(Debug, Clone)]
pub struct ActionResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Text response.
    pub text: String,
    /// Optional structured data.
    pub data: Option<Value>,
    /// Error message if failed.
    pub error: Option<String>,
}

/// Result of a provider execution.
#[derive(Debug, Clone)]
pub struct ProviderResult {
    /// Key-value pairs for state.
    pub values: Value,
    /// Text representation for context.
    pub text: String,
    /// Additional data.
    pub data: Value,
}

/// Trait for shell plugin actions.
#[async_trait]
pub trait Action: Send + Sync {
    /// Get the action name (e.g., "EXECUTE_COMMAND").
    fn name(&self) -> &str;
    
    /// Get action similes (alternative names).
    fn similes(&self) -> Vec<&str>;
    
    /// Get action description.
    fn description(&self) -> &str;
    
    /// Validate if this action should be executed for the given message.
    async fn validate(&self, message: &Value, state: &Value) -> bool;
    
    /// Execute the action.
    async fn handler(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&mut ShellService>,
    ) -> ActionResult;
    
    /// Get usage examples.
    fn examples(&self) -> Vec<ActionExample>;
}

/// Trait for shell plugin providers.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Get the provider name.
    fn name(&self) -> &str;
    
    /// Get provider description.
    fn description(&self) -> &str;
    
    /// Get provider position (for ordering).
    fn position(&self) -> i32;
    
    /// Get provider data.
    async fn get(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&ShellService>,
    ) -> ProviderResult;
}

/// Prelude module - convenient re-exports
pub mod prelude {
    pub use crate::actions::{ClearHistoryAction, ExecuteCommandAction};
    pub use crate::error::{Result, ShellError};
    pub use crate::providers::ShellHistoryProvider;
    pub use crate::service::ShellService;
    pub use crate::types::{CommandHistoryEntry, CommandResult, FileOperation, ShellConfig};
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
}
