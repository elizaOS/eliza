mod context_summary;
mod long_term_memory;

pub use context_summary::ContextSummaryProvider;
pub use long_term_memory::LongTermMemoryProvider;

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

/// Context provided to memory providers for retrieving memory information.
///
/// Contains identifiers and state needed to look up relevant memories
/// for the current conversation.
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// The unique identifier of the agent.
    pub agent_id: Uuid,
    /// The unique identifier of the entity (user) being interacted with.
    pub entity_id: Uuid,
    /// The unique identifier of the conversation room.
    pub room_id: Uuid,
    /// Additional state data as a JSON value.
    pub state: Value,
}

/// The result returned by a memory provider.
///
/// Contains structured data, template values, and formatted text
/// representing the retrieved memory information.
#[derive(Debug, Clone)]
pub struct ProviderResult {
    /// Structured data about the retrieved memories.
    pub data: Value,
    /// Template values for use in prompt generation.
    pub values: Value,
    /// Human-readable formatted text representation.
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

/// Trait defining the interface for memory providers.
///
/// Providers are responsible for retrieving and formatting memory information
/// to be included in agent context during interactions.
#[async_trait]
pub trait MemoryProvider: Send + Sync {
    /// Returns the unique name identifier for this provider.
    fn name(&self) -> &'static str;
    /// Returns a human-readable description of what this provider does.
    fn description(&self) -> &'static str;
    /// Returns the position/priority of this provider in the context assembly.
    fn position(&self) -> i32;
    /// Retrieves and formats memory information for the given context.
    async fn get(&self, context: &ProviderContext) -> ProviderResult;
}
