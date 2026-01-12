mod long_term_extraction;
mod summarization;

pub use long_term_extraction::LongTermExtractionEvaluator;
pub use summarization::SummarizationEvaluator;

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

/// Context provided to evaluators for processing memory-related tasks.
///
/// Contains all the necessary information about the current conversation state
/// that evaluators need to make decisions about memory operations.
#[derive(Debug, Clone)]
pub struct EvaluatorContext {
    /// The unique identifier of the agent.
    pub agent_id: Uuid,
    /// The unique identifier of the entity (user) being interacted with.
    pub entity_id: Uuid,
    /// The unique identifier of the conversation room.
    pub room_id: Uuid,
    /// The text content of the current message.
    pub message_text: String,
    /// The total count of messages in the current conversation.
    pub message_count: i32,
    /// Additional state data as a JSON value.
    pub state: Value,
}

/// The result returned by an evaluator after processing.
///
/// Contains information about whether the evaluation was successful
/// and any extracted data.
#[derive(Debug, Clone)]
pub struct EvaluatorResult {
    /// Whether the evaluation completed successfully.
    pub success: bool,
    /// Optional data extracted or produced by the evaluator.
    pub data: Option<Value>,
}

/// Trait defining the interface for memory evaluators.
///
/// Evaluators are responsible for analyzing conversations and extracting
/// or summarizing memory information based on configurable thresholds.
#[async_trait]
pub trait MemoryEvaluator: Send + Sync {
    /// Returns the unique name identifier for this evaluator.
    fn name(&self) -> &'static str;
    /// Returns a human-readable description of what this evaluator does.
    fn description(&self) -> &'static str;
    /// Returns alternative names or similar concepts for this evaluator.
    fn similes(&self) -> Vec<&'static str>;
    /// Returns whether this evaluator should always run regardless of validation.
    fn always_run(&self) -> bool {
        true
    }
    /// Validates whether this evaluator should run for the given context.
    async fn validate(&self, context: &EvaluatorContext) -> bool;
    /// Executes the evaluator logic and returns a result if processing occurred.
    async fn handler(&self, context: &EvaluatorContext) -> Option<EvaluatorResult>;
}
