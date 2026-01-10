//! Evaluators module for the elizaOS Bootstrap Plugin.
//!
//! This module contains all evaluator implementations.

mod reflection;

pub use reflection::ReflectionEvaluator;

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

/// Get all available evaluators.
pub fn all_evaluators() -> Vec<Box<dyn Evaluator>> {
    vec![
        Box::new(ReflectionEvaluator),
    ]
}

