//! Evaluators module for the elizaOS Bootstrap Plugin.
//!
//! This module contains all evaluator implementations.

mod reflection;
mod relationship_extraction;

pub use reflection::ReflectionEvaluator;
pub use relationship_extraction::RelationshipExtractionEvaluator;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{EvaluatorResult, Memory, State};
use async_trait::async_trait;

/// Trait that all evaluators must implement.
#[async_trait]
pub trait Evaluator: Send + Sync {
    /// Get the evaluator name.
    fn name(&self) -> &'static str;

    /// Get evaluator description.
    fn description(&self) -> &'static str;

    /// Validate whether evaluation can be performed.
    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool;

    /// Perform the evaluation.
    async fn evaluate(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<EvaluatorResult>;
}

/// Get basic evaluators (always available).
pub fn basic_evaluators() -> Vec<Box<dyn Evaluator>> {
    vec![]
}

/// Get extended evaluators (opt-in).
pub fn extended_evaluators() -> Vec<Box<dyn Evaluator>> {
    vec![
        Box::new(ReflectionEvaluator),
        Box::new(RelationshipExtractionEvaluator),
    ]
}

/// Get all available evaluators.
pub fn all_evaluators() -> Vec<Box<dyn Evaluator>> {
    let mut evaluators = basic_evaluators();
    evaluators.extend(extended_evaluators());
    evaluators
}
