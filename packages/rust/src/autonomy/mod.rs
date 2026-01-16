//! Built-in autonomy (gated by capability flag / settings).
//!
//! Parity-oriented features:
//! - Autonomy loop service (opt-in)
//! - SEND_TO_ADMIN action (restricted to autonomous room)
//! - ADMIN_CHAT_HISTORY + AUTONOMY_STATUS providers

mod action;
mod providers;
mod service;
mod types;

use std::sync::{Arc, Weak};

use crate::runtime::AgentRuntime;
use crate::types::plugin::Plugin;

pub use action::SendToAdminAction;
pub use providers::{AdminChatHistoryProvider, AutonomyStatusProvider};
pub use service::{AutonomyService, AUTONOMY_SERVICE_TYPE};
pub use types::AutonomyStatus;

/// Create the autonomy plugin (actions/providers) bound to a runtime + service.
pub fn create_autonomy_plugin(
    runtime: Weak<AgentRuntime>,
    service: Arc<AutonomyService>,
) -> Plugin {
    let mut plugin = Plugin::new(
        "autonomy",
        "Built-in autonomy capabilities (providers/actions) gated by ENABLE_AUTONOMY",
    );

    plugin = plugin
        .with_action(Arc::new(SendToAdminAction::new(
            runtime.clone(),
            service.clone(),
        )))
        .with_provider(Arc::new(AdminChatHistoryProvider::new(
            runtime.clone(),
            service.clone(),
        )))
        .with_provider(Arc::new(AutonomyStatusProvider::new(runtime, service)));

    plugin
}
