//! Autonomy Providers for elizaOS - Rust implementation.
//!
//! Providers that supply autonomous context information.

use crate::bootstrap::error::PluginResult;
use crate::bootstrap::providers::Provider;
use crate::bootstrap::types::{Memory, ProviderResult, State};

/// Admin Chat Provider.
///
/// Provides conversation history with admin user for autonomous context.
/// Only active in autonomous room to give agent memory of admin interactions.
pub struct AdminChatProvider;

impl AdminChatProvider {
    /// Create a new AdminChatProvider.
    pub fn new() -> Self {
        Self
    }
}

impl Default for AdminChatProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Provider for AdminChatProvider {
    fn name(&self) -> &str {
        "ADMIN_CHAT_HISTORY"
    }

    fn description(&self) -> &str {
        "Provides recent conversation history with the admin user for autonomous context"
    }

    fn private(&self) -> Option<bool> {
        Some(false)
    }

    async fn get(&self, _message: &Memory, _state: &State) -> PluginResult<ProviderResult> {
        // Simplified implementation - full version would query admin messages from runtime
        Ok(ProviderResult::new("[ADMIN_CHAT_HISTORY]\nNo admin messages available in this context.\n[/ADMIN_CHAT_HISTORY]"))
    }
}

/// Autonomy Status Provider.
///
/// Shows autonomy status in regular conversations.
/// Does NOT show in autonomous room to avoid unnecessary context.
pub struct AutonomyStatusProvider;

impl AutonomyStatusProvider {
    /// Create a new AutonomyStatusProvider.
    pub fn new() -> Self {
        Self
    }
}

impl Default for AutonomyStatusProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Provider for AutonomyStatusProvider {
    fn name(&self) -> &str {
        "AUTONOMY_STATUS"
    }

    fn description(&self) -> &str {
        "Provides current autonomy status for agent awareness in conversations"
    }

    fn private(&self) -> Option<bool> {
        Some(false)
    }

    async fn get(&self, _message: &Memory, _state: &State) -> PluginResult<ProviderResult> {
        // Simplified implementation - full version would query autonomy service status
        Ok(ProviderResult::new("[AUTONOMY_STATUS]\nCurrent status: 🔕 autonomy disabled\nThinking interval: 30 seconds\n[/AUTONOMY_STATUS]")
            .with_data("autonomyEnabled", false)
            .with_data("serviceRunning", false)
            .with_data("interval", 30000_u64)
            .with_data("status", "disabled"))
    }
}


