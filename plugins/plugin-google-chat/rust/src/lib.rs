//! Google Chat integration plugin for elizaOS agents.
//!
//! This plugin provides Google Chat integration with support for
//! sending messages, reactions, and space management.

pub mod types;
pub mod service;
pub mod actions;
pub mod providers;

pub use types::*;
pub use service::GoogleChatService;
pub use actions::*;
pub use providers::*;
