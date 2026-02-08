//! Action sampler implementations for SWE-agent
//!
//! Action samplers provide alternative strategies for selecting actions,
//! such as ensemble methods or trajectory comparison.
//!
//! NOTE: These are advanced features that require multiple model queries.
//! For basic usage, the default single-query approach is sufficient.

use crate::exceptions::{Result, SWEAgentError};
use crate::types::{History, ModelOutput, Trajectory};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Output from action sampling
#[derive(Debug, Clone)]
pub struct ActionSamplerOutput {
    pub completion: ModelOutput,
    pub extra_info: HashMap<String, serde_json::Value>,
}

/// Trait for action samplers
#[async_trait]
pub trait ActionSampler: Send + Sync {
    /// Get the best action given the current state
    async fn get_action(
        &self,
        problem_statement: &dyn super::ProblemStatement,
        trajectory: &Trajectory,
        history: &History,
    ) -> Result<ActionSamplerOutput>;
}

/// Simple pass-through sampler that uses the default model query
/// This is the baseline - no ensemble or comparison, just use what the model gives.
pub struct DefaultActionSampler;

impl DefaultActionSampler {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DefaultActionSampler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ActionSampler for DefaultActionSampler {
    async fn get_action(
        &self,
        _problem_statement: &dyn super::ProblemStatement,
        _trajectory: &Trajectory,
        _history: &History,
    ) -> Result<ActionSamplerOutput> {
        // This sampler doesn't do anything special - the agent's forward() handles the model query
        // This is meant to be overridden when you want custom sampling behavior
        Err(SWEAgentError::ConfigurationError(
            "DefaultActionSampler should not be called directly - agent handles model query"
                .to_string(),
        ))
    }
}

/// Configuration for action samplers
///
/// NOTE: Advanced samplers like AskColleagues and BinaryTrajectoryComparison
/// require custom model integration and are not implemented in this version.
/// They are defined here for API compatibility with the Python/TypeScript versions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionSamplerConfig {
    /// Default single-query sampler (recommended)
    #[default]
    Default,
    /// Placeholder for ask-colleagues ensemble (not implemented)
    AskColleagues {
        n_samples: usize,
        chooser_prompt: String,
    },
    /// Placeholder for trajectory comparison (not implemented)
    BinaryTrajectoryComparison { comparison_prompt: String },
}

/// Create an action sampler from configuration
pub fn create_action_sampler(config: &ActionSamplerConfig) -> Result<Box<dyn ActionSampler>> {
    match config {
        ActionSamplerConfig::Default => Ok(Box::new(DefaultActionSampler::new())),
        ActionSamplerConfig::AskColleagues { .. } => {
            Err(SWEAgentError::ConfigurationError(
                "AskColleagues sampler is not implemented in Rust. Use Default or implement custom sampling.".to_string()
            ))
        }
        ActionSamplerConfig::BinaryTrajectoryComparison { .. } => {
            Err(SWEAgentError::ConfigurationError(
                "BinaryTrajectoryComparison sampler is not implemented in Rust. Use Default or implement custom sampling.".to_string()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_sampler_config() {
        let config = ActionSamplerConfig::default();
        assert!(matches!(config, ActionSamplerConfig::Default));
    }

    #[test]
    fn test_create_default_sampler() {
        let config = ActionSamplerConfig::Default;
        let result = create_action_sampler(&config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_unimplemented_samplers_error() {
        let config = ActionSamplerConfig::AskColleagues {
            n_samples: 3,
            chooser_prompt: "test".to_string(),
        };
        let result = create_action_sampler(&config);
        assert!(result.is_err());
    }
}
