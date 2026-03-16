//! Matrix messaging integration plugin for elizaOS agents.
//!
//! This plugin provides Matrix protocol integration with support for
//! sending messages, reactions, and room management.

pub mod types;
pub mod service;
pub mod actions;
pub mod providers;

pub use types::*;
pub use service::MatrixService;
pub use actions::*;
pub use providers::*;
