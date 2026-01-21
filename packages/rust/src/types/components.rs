//! Component types (proto-backed) with runtime helpers.
//!
//! This module defines the core component types for actions, providers, and evaluators,
//! along with their handlers and runtime definitions.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

pub use super::generated::eliza::v1::{
    ActionExample, ActionParameter, ActionParameterSchema, EvaluationExample,
};
use super::memory::Memory;
use super::primitives::Content;
use super::state::State;

/// Type alias for action parameters stored as a JSON key-value map.
pub type ActionParameters = HashMap<String, JsonValue>;

/// Context passed to action handlers containing information about prior action executions.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionContext {
    /// Results from previously executed actions in the current chain.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_results: Vec<ActionResult>,
}

/// Options passed to action, provider, and evaluator handlers.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerOptions {
    /// Context from prior action executions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_context: Option<ActionContext>,
    /// Serialized action plan JSON for multi-step executions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_plan_json: Option<String>,
    /// Parameters passed to the handler.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<ActionParameters>,
}

/// Result returned by action handlers after execution.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    /// Whether the action completed successfully.
    pub success: bool,
    /// Optional text response from the action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Optional key-value pairs to merge into state values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<ActionParameters>,
    /// Optional structured data returned by the action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ActionParameters>,
    /// Error message if the action failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result returned by provider handlers after execution.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    /// Optional text content provided to the context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Optional key-value pairs to merge into state values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<ActionParameters>,
    /// Optional structured data from the provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ActionParameters>,
}

/// Helper to insert a value into an optional HashMap, creating it if needed.
fn insert_map_value(target: &mut Option<ActionParameters>, key: String, value: JsonValue) {
    let map = target.get_or_insert_with(HashMap::new);
    map.insert(key, value);
}

impl ActionResult {
    /// Creates a successful action result with the given message.
    pub fn success(message: impl Into<String>) -> Self {
        ActionResult {
            success: true,
            text: Some(message.into()),
            values: None,
            data: None,
            error: None,
        }
    }

    /// Creates a successful action result with the given text message.
    pub fn success_with_text(message: &str) -> Self {
        ActionResult {
            success: true,
            text: Some(message.to_string()),
            values: None,
            data: None,
            error: None,
        }
    }

    /// Creates a failed action result with the given error message.
    pub fn failure(message: &str) -> Self {
        ActionResult {
            success: false,
            text: None,
            values: None,
            data: None,
            error: Some(message.to_string()),
        }
    }

    /// Adds a key-value pair to the result's values map.
    pub fn with_value(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.values, key.into(), value.into());
        self
    }

    /// Adds a key-value pair to the result's data map.
    pub fn with_data(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.data, key.into(), value.into());
        self
    }
}

impl ProviderResult {
    /// Creates a new provider result with the given text.
    pub fn new(text: impl Into<String>) -> Self {
        ProviderResult {
            text: Some(text.into()),
            values: None,
            data: None,
        }
    }

    /// Creates a provider result with the given text content.
    pub fn with_text(text: impl Into<String>) -> Self {
        ProviderResult {
            text: Some(text.into()),
            values: None,
            data: None,
        }
    }

    /// Creates an empty provider result with no content.
    pub fn empty() -> Self {
        ProviderResult::new("")
    }

    /// Adds a key-value pair to the result's values map.
    pub fn with_value(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.values, key.into(), value.into());
        self
    }

    /// Adds a key-value pair to the result's data map.
    pub fn with_data(mut self, key: impl Into<String>, value: impl Into<JsonValue>) -> Self {
        insert_map_value(&mut self.data, key.into(), value.into());
        self
    }
}

// Runtime definitions (not in proto)

/// Definition metadata for an action.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", bound(serialize = "", deserialize = ""))]
pub struct ActionDefinition {
    /// Unique name identifier for the action.
    pub name: String,
    /// Human-readable description of what the action does.
    pub description: String,
    /// Alternative names that can trigger this action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similes: Option<Vec<String>>,
    /// Examples are skipped during serialization as they contain proto types
    #[serde(skip, default)]
    pub examples: Option<Vec<Vec<ActionExample>>>,
    /// Execution priority (higher runs first).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    /// Tags for categorization and filtering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Parameters are skipped during serialization as they contain proto types
    #[serde(skip, default)]
    pub parameters: Option<Vec<ActionParameter>>,
}

/// Definition metadata for a provider.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinition {
    /// Unique name identifier for the provider.
    pub name: String,
    /// Human-readable description of what the provider provides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the provider generates dynamic content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<bool>,
    /// Position in provider ordering (lower runs first).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
    /// Whether the provider output is private (not included in prompts).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
}

/// Definition metadata for an evaluator.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", bound(serialize = "", deserialize = ""))]
pub struct EvaluatorDefinition {
    /// Unique name identifier for the evaluator.
    pub name: String,
    /// Human-readable description of what the evaluator does.
    pub description: String,
    /// Whether to run this evaluator on every message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_run: Option<bool>,
    /// Alternative names that can trigger this evaluator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similes: Option<Vec<String>>,
    /// Examples are skipped during serialization as they contain proto types
    #[serde(skip, default)]
    pub examples: Vec<EvaluationExample>,
}

/// Callback type for handling content and producing memories.
pub type HandlerCallback = Box<
    dyn Fn(Content) -> Pin<Box<dyn Future<Output = Vec<Memory>> + Send + 'static>> + Send + Sync,
>;

/// Callback type for handling streaming text chunks.
pub type StreamChunkCallback =
    Box<dyn Fn(&str, Option<&str>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Trait for implementing action handlers.
///
/// Actions are discrete operations that the agent can perform in response to messages,
/// such as sending replies, executing commands, or interacting with external services.
#[async_trait]
pub trait ActionHandler: Send + Sync {
    /// Returns the definition metadata for this action.
    fn definition(&self) -> ActionDefinition;
    /// Validates whether this action should run for the given message and state.
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;
    /// Executes the action and returns the result.
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error>;
}

/// Trait for implementing provider handlers.
///
/// Providers supply contextual information to the agent's decision-making process,
/// such as time, character details, recent messages, or external data.
#[async_trait]
pub trait ProviderHandler: Send + Sync {
    /// Returns the definition metadata for this provider.
    fn definition(&self) -> ProviderDefinition;
    /// Retrieves the provider's content for the given message and state.
    async fn get(&self, message: &Memory, state: &State) -> Result<ProviderResult, anyhow::Error>;
}

/// Trait for implementing evaluator handlers.
///
/// Evaluators analyze messages and state to determine conditions or extract information,
/// such as detecting sentiment, identifying intents, or triggering follow-up actions.
#[async_trait]
pub trait EvaluatorHandler: Send + Sync {
    /// Returns the definition metadata for this evaluator.
    fn definition(&self) -> EvaluatorDefinition;
    /// Validates whether this evaluator should run for the given message and state.
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;
    /// Executes the evaluation and returns the result.
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error>;
}
