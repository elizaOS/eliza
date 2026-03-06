//! Signal messaging integration plugin for elizaOS agents.
//!
//! This plugin provides end-to-end encrypted messaging capabilities
//! via the Signal protocol using the Signal CLI REST API.

pub mod types;
pub mod service;
pub mod actions;
pub mod providers;

pub use types::*;
pub use service::SignalService;
pub use actions::*;
pub use providers::*;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "signal";
pub const PLUGIN_DESCRIPTION: &str = "Signal messaging integration plugin for elizaOS with end-to-end encryption";
pub const PLUGIN_VERSION: &str = "2.0.0-alpha";
