//! MCP providers module.
//!
//! Contains provider implementations for MCP context.

mod mcp;

pub use mcp::McpProvider;

use async_trait::async_trait;
use serde_json::Value;

/// Context for provider operations.
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// Current state
    pub state: Value,
}

/// Result of a provider get operation.
#[derive(Debug, Clone)]
pub struct ProviderResult {
    /// Key-value pairs for template substitution
    pub values: Value,
    /// Structured data
    pub data: Value,
    /// Text representation for context
    pub text: String,
}

impl Default for ProviderResult {
    fn default() -> Self {
        Self {
            values: serde_json::json!({}),
            data: serde_json::json!({}),
            text: String::new(),
        }
    }
}

/// Trait for MCP providers.
#[async_trait]
pub trait McpProviderTrait: Send + Sync {
    /// Get provider name.
    fn name(&self) -> &'static str;

    /// Get provider description.
    fn description(&self) -> &'static str;

    /// Get the provider result.
    async fn get(&self, context: &ProviderContext) -> ProviderResult;
}
