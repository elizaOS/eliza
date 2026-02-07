#![allow(missing_docs)]

//! # elizaos-plugin-cli
//!
//! CLI framework plugin for elizaOS agents.
//!
//! Provides:
//! - CLI command registration and management via [`CliRegistry`]
//! - Type definitions for commands, arguments, and contexts
//! - Duration/timeout parsing and formatting utilities
//! - Progress reporting
//!
//! This plugin is infrastructure — it does not register actions or providers,
//! but exports types and services consumed by other CLI-related plugins.

mod registry;
mod types;
mod utils;

// Re-export the registry.
pub use registry::{define_and_register, CliRegistry};

// Re-export all types.
pub use types::{
    CliArg, CliCommand, CliContext, CliLogger, CliPluginConfig, CommonCommandOptions,
    DefaultCliLogger, ParsedDuration, ProgressReporter,
};

// Re-export utilities.
pub use utils::{
    format_bytes, format_cli_command, format_duration, parse_duration, parse_timeout_ms,
    truncate_string, DEFAULT_CLI_NAME, DEFAULT_CLI_VERSION,
};

/// Plugin name constant.
pub const PLUGIN_NAME: &str = "cli";
/// Plugin description constant.
pub const PLUGIN_DESCRIPTION: &str = "CLI framework plugin for command registration and execution";
/// Plugin version from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Convenience prelude that re-exports the most commonly needed items.
pub mod prelude {
    pub use crate::registry::CliRegistry;
    pub use crate::types::{
        CliArg, CliCommand, CliContext, CliLogger, CliPluginConfig, CommonCommandOptions,
        DefaultCliLogger, ParsedDuration, ProgressReporter,
    };
    pub use crate::utils::{
        format_bytes, format_cli_command, format_duration, parse_duration, parse_timeout_ms,
        truncate_string, DEFAULT_CLI_NAME, DEFAULT_CLI_VERSION,
    };
    pub use crate::{PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};
}
