//! elizaOS Slack Plugin
//!
//! Slack integration plugin for elizaOS agents with Socket Mode support.

pub mod types;
pub mod service;
pub mod actions;
pub mod providers;

pub use types::*;
pub use service::SlackService;
pub use actions::*;
pub use providers::*;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "slack";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PLUGIN_DESCRIPTION: &str = "Slack integration plugin for elizaOS with Socket Mode support";
