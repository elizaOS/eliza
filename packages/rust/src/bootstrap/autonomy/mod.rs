//! Autonomy Module for elizaOS Bootstrap - Rust implementation.
//!
//! Provides autonomous operation capabilities for agents.

pub mod action;
pub mod providers;
pub mod service;
pub mod types;

pub use action::SendToAdminAction;
pub use providers::{AdminChatProvider, AutonomyStatusProvider};
pub use service::{AutonomyService, AUTONOMY_SERVICE_TYPE};
pub use types::{AutonomyConfig, AutonomyStatus};
