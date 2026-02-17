//! Twitch chat integration plugin for elizaOS agents.
//!
//! This plugin provides Twitch chat integration using IRC over WebSocket.

pub mod types;
pub mod service;
pub mod actions;
pub mod providers;

pub use types::*;
pub use service::TwitchService;
pub use actions::*;
pub use providers::*;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "twitch";
pub const PLUGIN_DESCRIPTION: &str = "Twitch chat integration plugin for elizaOS with real-time messaging";
pub const PLUGIN_VERSION: &str = "2.0.0-alpha";
