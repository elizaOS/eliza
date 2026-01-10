//! Autonomy Module for elizaOS Bootstrap - Rust implementation.
//!
//! Provides autonomous operation capabilities for agents.

pub mod types;
pub mod service;
pub mod action;
pub mod providers;

pub use types::{AutonomyConfig, AutonomyStatus};
pub use service::{AutonomyService, AUTONOMY_SERVICE_TYPE};
pub use action::SendToAdminAction;
pub use providers::{AdminChatProvider, AutonomyStatusProvider};

