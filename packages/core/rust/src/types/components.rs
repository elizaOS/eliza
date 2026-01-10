//! Component types for elizaOS
//!
//! Contains Action, Provider, Evaluator, Handler, and related types.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::{Content, Memory, State};

/// Example content with associated user for demonstration
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionExample {
    /// User associated with the example
    pub name: String,
    /// Content of the example
    pub content: Content,
}

/// Result returned by an action after execution
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    /// Optional text description of the result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Values to merge into the state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, serde_json::Value>>,
    /// Data payload containing action-specific results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
    /// Whether the action succeeded
    pub success: bool,
    /// Error information if the action failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ActionResult {
    /// Create a successful result
    pub fn success() -> Self {
        ActionResult {
            success: true,
            ..Default::default()
        }
    }

    /// Create a successful result with text
    pub fn success_with_text(text: &str) -> Self {
        ActionResult {
            success: true,
            text: Some(text.to_string()),
            ..Default::default()
        }
    }

    /// Create a failed result
    pub fn failure(error: &str) -> Self {
        ActionResult {
            success: false,
            error: Some(error.to_string()),
            ..Default::default()
        }
    }
}

/// Context provided to actions during execution
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionContext {
    /// Results from previously executed actions in this run
    pub previous_results: Vec<ActionResult>,
}

impl ActionContext {
    /// Get a specific previous result by action name
    pub fn get_previous_result(&self, _action_name: &str) -> Option<&ActionResult> {
        // In a real implementation, this would look up by name
        self.previous_results.last()
    }
}

/// Step in an action plan
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionPlanStep {
    /// Action name
    pub action: String,
    /// Step status
    pub status: ActionStepStatus,
    /// Error if failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Result if completed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ActionResult>,
}

/// Status of an action step
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActionStepStatus {
    /// Not yet started
    Pending,
    /// Successfully completed
    Completed,
    /// Failed to complete
    Failed,
}

/// Multi-step action plan
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionPlan {
    /// AI's reasoning for this execution plan
    pub thought: String,
    /// Total number of steps
    pub total_steps: usize,
    /// Current step (1-based)
    pub current_step: usize,
    /// Array of steps
    pub steps: Vec<ActionPlanStep>,
}

/// Options passed to action handlers
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerOptions {
    /// Context with previous action results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_context: Option<ActionContext>,
    /// Multi-step action plan
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_plan: Option<ActionPlan>,
    /// Validated input parameters extracted from conversation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<HashMap<String, serde_json::Value>>,
    /// Additional options
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Result from a provider
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResult {
    /// Human-readable text for LLM prompt inclusion
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Key-value pairs for template variable substitution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, serde_json::Value>>,
    /// Structured data for programmatic access
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

/// Example for evaluating agent behavior
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationExample {
    /// Evaluation context
    pub prompt: String,
    /// Example messages
    pub messages: Vec<ActionExample>,
    /// Expected outcome
    pub outcome: String,
}

// Type aliases for handler functions (these will be trait objects in practice)
/// Handler callback function type
pub type HandlerCallback =
    Arc<dyn Fn(Content) -> Pin<Box<dyn Future<Output = Vec<Memory>> + Send>> + Send + Sync>;

/// JSON Schema for action parameter validation
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionParameterSchema {
    /// JSON Schema type (string, number, boolean, object, array)
    #[serde(rename = "type")]
    pub schema_type: String,
    /// Description for LLM guidance
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Default value if parameter is not provided
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    /// Allowed values for enum-style parameters
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    /// For object types, nested properties
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<HashMap<String, serde_json::Value>>,
    /// For array types, item schema
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ActionParameterSchema>>,
    /// Minimum value for numbers
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    /// Maximum value for numbers
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    /// Pattern for string validation (regex)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

/// Defines a single parameter for an action
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionParameter {
    /// Parameter name (used as key in parameters object)
    pub name: String,
    /// Human-readable description for LLM guidance
    pub description: String,
    /// Whether this parameter is required
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// JSON Schema for parameter validation
    pub schema: ActionParameterSchema,
}

/// Action definition for serialization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDefinition {
    /// Action name
    pub name: String,
    /// Detailed description
    pub description: String,
    /// Similar action descriptions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similes: Option<Vec<String>>,
    /// Example usages
    #[serde(skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<Vec<ActionExample>>>,
    /// Priority for action ordering
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    /// Tags for categorization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Input parameters for the action
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<ActionParameter>>,
}

/// Provider definition for serialization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinition {
    /// Provider name
    pub name: String,
    /// Provider description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether the provider is dynamic
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<bool>,
    /// Position in provider list
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i32>,
    /// Whether the provider is private
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private: Option<bool>,
}

/// Evaluator definition for serialization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorDefinition {
    /// Evaluator name
    pub name: String,
    /// Detailed description
    pub description: String,
    /// Whether to always run
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_run: Option<bool>,
    /// Similar evaluator descriptions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similes: Option<Vec<String>>,
    /// Example evaluations
    pub examples: Vec<EvaluationExample>,
}

/// Trait for action handlers
#[async_trait]
pub trait ActionHandler: Send + Sync {
    /// Get the action definition
    fn definition(&self) -> ActionDefinition;

    /// Validate if the action should run
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;

    /// Execute the action
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>, anyhow::Error>;
}

/// Trait for provider handlers
#[async_trait]
pub trait ProviderHandler: Send + Sync {
    /// Get the provider definition
    fn definition(&self) -> ProviderDefinition;

    /// Get provider data
    async fn get(&self, message: &Memory, state: &State) -> Result<ProviderResult, anyhow::Error>;
}

/// Trait for evaluator handlers
#[async_trait]
pub trait EvaluatorHandler: Send + Sync {
    /// Get the evaluator definition
    fn definition(&self) -> EvaluatorDefinition;

    /// Validate if the evaluator should run
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;

    /// Execute the evaluator
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
    ) -> Result<Option<ActionResult>, anyhow::Error>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_result_serialization() {
        let result = ActionResult::success_with_text("Done!");
        let json = serde_json::to_string(&result).unwrap();

        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"text\":\"Done!\""));
    }

    #[test]
    fn test_action_definition_serialization() {
        let action = ActionDefinition {
            name: "test_action".to_string(),
            description: "A test action".to_string(),
            similes: Some(vec!["similar action".to_string()]),
            examples: None,
        };

        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("\"name\":\"test_action\""));
    }
}
