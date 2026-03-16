//! Services module for the elizaOS Bootstrap Plugin.
//!
//! This module contains all service implementations.

mod embedding;
mod follow_up;
mod rolodex;
mod task;

pub use embedding::EmbeddingService;
pub use follow_up::{FollowUpService, FollowUpSuggestion, FollowUpTask};
pub use rolodex::{
    calculate_relationship_strength, ContactInfo, ContactPreferences, RelationshipAnalytics,
    RolodexService,
};
pub use task::{Task, TaskPriority, TaskService, TaskStatus};

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use async_trait::async_trait;
use std::sync::Arc;

/// Service type enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceType {
    /// Core service
    Core,
    /// Plugin service
    Plugin,
    /// External service
    External,
}

/// Trait that all services must implement.
#[async_trait]
pub trait Service: Send + Sync {
    /// Get the service name.
    fn name(&self) -> &'static str;

    /// Get the service type.
    fn service_type(&self) -> ServiceType;

    /// Start the service.
    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()>;

    /// Stop the service.
    async fn stop(&mut self) -> PluginResult<()>;
}
