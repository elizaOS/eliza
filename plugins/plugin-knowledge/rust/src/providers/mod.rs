//! Knowledge providers module.
//!
//! Contains provider implementations for knowledge context.

mod documents;
mod knowledge;

pub use documents::DocumentsProvider;
pub use knowledge::KnowledgeProvider;

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

/// Context for provider operations.
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// Agent ID
    pub agent_id: Uuid,
    /// Entity ID
    pub entity_id: Option<Uuid>,
    /// Room ID
    pub room_id: Option<Uuid>,
    /// Query text (for dynamic providers)
    pub query: Option<String>,
    /// Current state
    pub state: Value,
}

/// Result of a provider get operation.
#[derive(Debug, Clone)]
pub struct ProviderResult {
    /// Structured data
    pub data: Value,
    /// Key-value pairs for template substitution
    pub values: Value,
    /// Text representation for context
    pub text: String,
}

impl Default for ProviderResult {
    fn default() -> Self {
        Self {
            data: serde_json::json!({}),
            values: serde_json::json!({}),
            text: String::new(),
        }
    }
}

/// Trait for knowledge providers.
#[async_trait]
pub trait KnowledgeProviderTrait: Send + Sync {
    /// Get provider name.
    fn name(&self) -> &'static str;

    /// Get provider description.
    fn description(&self) -> &'static str;

    /// Whether this provider is dynamic (changes based on message).
    fn dynamic(&self) -> bool;

    /// Get the provider result.
    async fn get(&self, context: &ProviderContext) -> ProviderResult;
}
